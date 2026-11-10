import { createHash } from 'node:crypto';
import { runScript, type LuaScript } from '@encurtador/db/cache';
import type { GeoLookup } from '@encurtador/geo';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import type { WorkerConfig } from './config';
import { enrich, fieldsToRecord, parseEvent, UaCache, type ClickEvent } from './events';
import { createMetrics, type Metrics } from './metrics';
import {
  dropOldClickPartitions,
  ensurePartitions,
  insertBatch,
  isTransient,
  type BatchResult,
} from './sql';

type Entry = [id: string, fields: string[]];

export interface WorkerDeps {
  sql: Sql;
  /** Conexão para comandos normais (XACK, XADD, PUBLISH, XPENDING, XCLAIM). */
  redis: Redis;
  /** Conexão dedicada ao XREADGROUP BLOCK (um comando bloqueante prende a conexão). */
  blockingRedis: Redis;
  geo: GeoLookup;
  config: WorkerConfig;
  log: Logger;
  /** Só testes: roda depois do COMMIT e antes do XACK (para simular um crash nesse ponto). */
  afterCommit?: (ids: string[]) => void | Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const lua = (body: string): LuaScript => ({
  lua: body,
  sha: createHash('sha1').update(body).digest('hex'),
});

/**
 * Move uma mensagem para a dead letter de forma atômica e por um worker só: o XADD em `<stream>:dead`
 * só acontece se o XACK desta chamada confirmou a mensagem (devolveu 1). Dois workers decidindo
 * matar o mesmo id ao mesmo tempo geram uma entrada só.
 * KEYS = stream, stream:dead, stream:fails. ARGV = grupo, id, motivo, falhas, campos….
 */
const DEAD_LETTER = lua(`
if redis.call('XACK', KEYS[1], ARGV[1], ARGV[2]) ~= 1 then return 0 end
local f = {'original_id', ARGV[2], 'reason', ARGV[3], 'failures', ARGV[4]}
for i = 5, #ARGV do f[#f + 1] = ARGV[i] end
redis.call('XADD', KEYS[2], 'MAXLEN', '~', 100000, '*', unpack(f))
redis.call('HDEL', KEYS[3], ARGV[2])
return 1
`);

const isNoGroup = (err: unknown) =>
  err instanceof Error && /NOGROUP|no such key/i.test(err.message);

/**
 * Consumidor do stream de cliques (ADR 0003): XREADGROUP em lotes de até `batchSize` ou
 * `flushIntervalMs`, uma instrução SQL por lote, XACK depois do COMMIT, PUBLISH para o ao vivo,
 * reclaim periódico de pendências de consumidores mortos e dead letter para mensagens venenosas.
 *
 * Garantias contra roubo e morte indevida:
 * - os ids em andamento (lidos e ainda não confirmados) ficam em `inFlight`; o reclaim nunca os
 *   reivindica, e um batimento (XCLAIM … JUSTID, que não soma entrega) mantém o idle deles baixo
 *   para que outros workers também não os peguem enquanto o Postgres está lento;
 * - o reclaim usa XPENDING + XCLAIM com min-idle: só um worker ganha cada id;
 * - a dead letter conta **falhas reais** (evento inválido, que vai direto; ou erro de dado do
 *   Postgres, contado em `<stream>:fails`), nunca entregas: ser reentregue porque um consumidor
 *   morreu não é falha.
 */
export class ClickWorker {
  readonly metrics: Metrics;
  private readonly uas = new UaCache();
  private stopping = false;
  private loop: Promise<void> | null = null;
  private reclaimTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private partitionTimer: NodeJS.Timeout | null = null;
  /** Serializa o processamento (laço principal e reclaim não gravam ao mesmo tempo). */
  private chain: Promise<unknown> = Promise.resolve();
  private crashed = false;
  private reclaiming = false;
  /** Ids lidos ou reivindicados por este consumidor e ainda em processamento. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly d: WorkerDeps) {
    this.metrics = createMetrics(() => this.streamInfo());
  }

  get deadStream(): string {
    return `${this.d.config.stream}:dead`;
  }

  get failsKey(): string {
    return `${this.d.config.stream}:fails`;
  }

  /** XGROUP CREATE … 0 MKSTREAM; idempotente (BUSYGROUP é ignorado). */
  async ensureGroup(): Promise<void> {
    const { redis, config } = this.d;
    try {
      // Começa do 0: eventos publicados antes do primeiro worker (ou antes de o grupo ser recriado
      // depois de um DEL/FLUSH) também são processados.
      await redis.xgroup('CREATE', config.stream, config.group, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) throw err;
    }
  }

  /** Executa um comando que depende do grupo; se o stream/grupo sumiu, recria e devolve null. */
  private async withGroup<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      if (!isNoGroup(err)) throw err;
      this.d.log.warn({ stream: this.d.config.stream }, 'stream ou grupo sumiu; recriando');
      await this.ensureGroup();
      return null;
    }
  }

  async start(): Promise<void> {
    const { config, sql, log } = this.d;
    await this.ensureGroup();
    const created = await ensurePartitions(sql);
    if (created > 0) log.info({ created }, 'partições criadas');
    await this.retention();
    this.partitionTimer = setInterval(
      () =>
        void ensurePartitions(sql)
          .catch((err) => log.error({ err }, 'falha ao criar partições'))
          .then(() => this.retention()),
      12 * 3600 * 1000,
    );
    this.partitionTimer.unref();
    this.reclaimTimer = setInterval(() => void this.reclaim(), config.reclaimIntervalMs);
    this.reclaimTimer.unref();
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat(),
      Math.max(25, Math.floor(config.reclaimIdleMs / 3)),
    );
    this.heartbeatTimer.unref();
    this.loop = this.run();
    log.info(
      { stream: config.stream, group: config.group, consumer: config.consumer },
      'worker iniciado',
    );
  }

  /**
   * Para de ler, termina o lote em mãos e confirma o que gravou. Se não terminar em
   * `stopTimeoutMs` (ex.: Postgres preso num lock), desiste sem XACK: o PEL cobre.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of [this.reclaimTimer, this.partitionTimer, this.heartbeatTimer]) {
      if (t) clearInterval(t);
    }
    const done = (async () => {
      await this.loop;
      await this.chain.catch(() => {});
    })();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      done.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), this.d.config.stopTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      this.crashed = true;
      this.d.log.warn(
        { pending: this.inFlight.size },
        'encerramento passou do prazo; saindo sem confirmar o lote em andamento',
      );
    }
  }

  /**
   * Retenção da bruta (desligada por padrão). Roda na partida e junto da manutenção de partições, a
   * cada 12 h. Falha (lock_timeout com um lote em andamento, por exemplo) só é registrada: a
   * próxima rodada tenta de novo, e nada do caminho dos cliques depende dela.
   */
  async retention(): Promise<number> {
    const { config, sql, log } = this.d;
    if (config.clickRetentionMonths === null) return 0;
    try {
      const dropped = await dropOldClickPartitions(sql, config.clickRetentionMonths);
      if (dropped > 0) {
        log.info({ dropped, months: config.clickRetentionMonths }, 'partições antigas apagadas');
      }
      return dropped;
    } catch (err) {
      log.error({ err }, 'falha na retenção da bruta');
      return 0;
    }
  }

  private async run(): Promise<void> {
    const { blockingRedis, config, log } = this.d;
    let batch: Entry[] = [];
    let deadline = 0;
    while (!this.stopping && !this.crashed) {
      const now = Date.now();
      const block =
        batch.length === 0 ? config.blockMs : Math.max(1, Math.min(config.blockMs, deadline - now));
      let res: [string, Entry[]][] | null;
      try {
        res = (await blockingRedis.xreadgroup(
          'GROUP',
          config.group,
          config.consumer,
          'COUNT',
          config.batchSize - batch.length,
          'BLOCK',
          block,
          'STREAMS',
          config.stream,
          '>',
        )) as [string, Entry[]][] | null;
      } catch (err) {
        if (this.stopping) break;
        if (isNoGroup(err)) {
          log.warn({ stream: config.stream }, 'NOGROUP no XREADGROUP; recriando o grupo');
          await this.ensureGroup().catch(() => {});
          continue;
        }
        log.error({ err: (err as Error).message }, 'XREADGROUP falhou; tentando de novo');
        await sleep(500);
        continue;
      }
      const entries = res?.[0]?.[1] ?? [];
      if (entries.length > 0) {
        if (batch.length === 0) deadline = Date.now() + config.flushIntervalMs;
        for (const [id] of entries) this.inFlight.add(id);
        batch = batch.concat(entries);
      }
      if (batch.length > 0 && (batch.length >= config.batchSize || Date.now() >= deadline)) {
        const current = batch;
        batch = [];
        await this.process(current);
      }
    }
    if (batch.length > 0 && !this.crashed) await this.process(batch);
  }

  /** Processa um lote; serializado com o reclaim. */
  process(entries: Entry[]): Promise<void> {
    const p = this.chain.then(() => this.processNow(entries));
    this.chain = p.catch(() => {});
    return p;
  }

  private async processNow(entries: Entry[]): Promise<void> {
    try {
      await this.processEntries(entries);
    } finally {
      for (const [id] of entries) this.inFlight.delete(id);
    }
  }

  private async processEntries(entries: Entry[]): Promise<void> {
    if (entries.length === 0 || this.crashed) return;
    const { log } = this.d;
    const end = this.metrics.batchDuration.startTimer();
    const valid: { id: string; fields: string[]; event: ClickEvent }[] = [];
    for (const [id, fields] of entries) {
      const r = parseEvent(fieldsToRecord(fields));
      if (r.ok) {
        if (r.tsMismatch) this.metrics.tsMismatch.inc();
        valid.push({ id, fields, event: r.event });
      } else {
        // Erro determinístico: reentregar não adianta, vai direto para a dead letter.
        this.metrics.invalid.inc();
        log.warn({ id, reason: r.reason }, 'evento inválido');
        await this.deadLetter(id, fields, `parse:${r.reason}`, 1);
      }
    }
    if (valid.length === 0) {
      end();
      return;
    }
    this.metrics.batchSize.observe(valid.length);

    const okIds = await this.writeWithFallback(valid);
    if (okIds === null || this.crashed) {
      end();
      return;
    }
    if (this.d.afterCommit) {
      try {
        await this.d.afterCommit(okIds);
      } catch (err) {
        // Crash simulado entre o COMMIT e o XACK: para tudo sem confirmar.
        this.crashed = true;
        this.stopping = true;
        log.error({ err: (err as Error).message }, 'crash depois do commit (sem XACK)');
        end();
        return;
      }
    }
    if (okIds.length > 0 && !this.crashed) {
      await this.withGroup(() =>
        this.d.redis.xack(this.d.config.stream, this.d.config.group, ...okIds),
      );
    }
    end();
  }

  /**
   * Grava o lote. Erro transitório: repete o lote inteiro com espera crescente (as mensagens
   * continuam pendentes e protegidas pelo batimento). Erro de dado (classe 22/23): grava um a um;
   * cada evento recusado soma uma falha em `<stream>:fails` e, com `maxDeliveries` falhas, vai para
   * a dead letter. Devolve os ids que podem ser confirmados.
   */
  private async writeWithFallback(
    valid: { id: string; fields: string[]; event: ClickEvent }[],
  ): Promise<string[] | null> {
    const { sql, geo, log, redis, config } = this.d;
    const rows = valid.map((v) => enrich(v.event, geo, this.uas));
    for (let attempt = 0; ; attempt++) {
      try {
        this.account(valid.length, await insertBatch(sql, rows));
        return valid.map((v) => v.id);
      } catch (err) {
        if (isTransient(err)) {
          const code = (err as { code?: string }).code ?? 'conn';
          this.metrics.retries.inc({ reason: code });
          if ((this.stopping || this.crashed) && attempt >= 3) {
            log.error({ code }, 'encerrando com lote não gravado; fica pendente');
            return null;
          }
          log.warn({ code, attempt }, 'erro transitório no lote; repetindo');
          await sleep(Math.min(5000, 50 * 2 ** attempt));
          continue;
        }
        log.error({ err: (err as Error).message }, 'lote recusado; gravando um a um');
        const ok: string[] = [];
        for (let i = 0; i < rows.length; i++) {
          const v = valid[i]!;
          try {
            this.account(1, await insertBatch(sql, [rows[i]!]));
            ok.push(v.id);
          } catch (e) {
            if (isTransient(e)) return ok; // o resto volta pelo reclaim
            const code = (e as { code?: string }).code ?? 'erro';
            const fails = await redis.hincrby(this.failsKey, v.id, 1);
            await redis.expire(this.failsKey, 7 * 24 * 3600);
            this.metrics.invalid.inc();
            log.warn({ id: v.id, code, fails }, 'evento recusado pelo banco');
            if (fails >= config.maxDeliveries)
              await this.deadLetter(v.id, v.fields, `db:${code}`, fails);
          }
        }
        return ok;
      }
    }
  }

  private account(validCount: number, result: BatchResult): void {
    const { inserted, known } = result;
    this.metrics.unknownLink.inc(validCount - known);
    this.metrics.duplicates.inc(known - inserted.length);
    const live = new Map<string, Map<string, { humans: number; total: number }>>();
    for (const r of inserted) {
      this.metrics.processed.inc({ kind: r.kind });
      if (!r.user_id) continue;
      const perUser = live.get(r.user_id) ?? new Map();
      const c = perUser.get(r.link_id) ?? { humans: 0, total: 0 };
      c.total++;
      if (r.kind === 'human') c.humans++;
      perUser.set(r.link_id, c);
      live.set(r.user_id, perUser);
    }
    for (const [userId, perLink] of live) {
      for (const [linkId, c] of perLink) {
        void this.d.redis
          .publish(
            `${this.d.config.liveChannelPrefix}${userId}`,
            JSON.stringify({ link_id: Number(linkId), ...c }),
          )
          .catch(() => {});
      }
    }
  }

  /**
   * Mantém baixo o idle dos ids em andamento (XCLAIM com JUSTID não soma entrega), para que o
   * reclaim de outro worker não os tome enquanto este ainda está gravando.
   */
  private async heartbeat(): Promise<void> {
    if (this.inFlight.size === 0 || this.crashed) return;
    const { redis, config } = this.d;
    const ids = [...this.inFlight];
    try {
      for (let i = 0; i < ids.length; i += 1000) {
        await this.withGroup(() =>
          redis.xclaim(
            config.stream,
            config.group,
            config.consumer,
            0,
            ...ids.slice(i, i + 1000),
            'JUSTID',
          ),
        );
      }
    } catch (err) {
      this.d.log.warn({ err: (err as Error).message }, 'batimento falhou');
    }
  }

  /**
   * Reivindica pendências paradas há mais de `reclaimIdleMs` (consumidor morto, ou evento que falhou
   * por erro de dado e espera nova tentativa). Nunca pega os próprios ids em andamento, não roda em
   * paralelo consigo mesmo, e o XCLAIM com min-idle garante que só um worker ganhe cada id.
   */
  async reclaim(): Promise<void> {
    if (this.stopping || this.reclaiming || this.crashed) return;
    this.reclaiming = true;
    const { redis, config, log } = this.d;
    try {
      const pending =
        ((await this.withGroup(() =>
          redis.call(
            'XPENDING',
            config.stream,
            config.group,
            'IDLE',
            config.reclaimIdleMs,
            '-',
            '+',
            config.batchSize,
          ),
        )) as [string, string, number, number][] | null) ?? [];
      const ids = pending
        .filter(([id, consumer]) => !(consumer === config.consumer && this.inFlight.has(id)))
        .map(([id]) => id);
      if (ids.length === 0) return;
      const claimed =
        ((await this.withGroup(() =>
          redis.xclaim(config.stream, config.group, config.consumer, config.reclaimIdleMs, ...ids),
        )) as (Entry | null)[] | null) ?? [];
      const live = claimed.filter((e): e is Entry => Array.isArray(e) && Array.isArray(e[1]));
      if (live.length === 0) return;
      this.metrics.reclaimed.inc(live.length);
      for (const [id] of live) this.inFlight.add(id);
      await this.process(live);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'reclaim falhou');
    } finally {
      this.reclaiming = false;
    }
  }

  private async deadLetter(id: string, fields: string[], reason: string, failures: number) {
    const { redis, config, log } = this.d;
    const moved = await this.withGroup(() =>
      runScript(
        redis,
        DEAD_LETTER,
        [config.stream, this.deadStream, this.failsKey],
        [config.group, id, reason, failures, ...fields],
      ),
    );
    if (moved === 1) {
      this.metrics.dead.inc();
      log.warn({ id, reason, failures }, 'mensagem movida para a dead letter');
    }
  }

  async streamInfo(): Promise<{ lag: number; pending: number } | null> {
    const { redis, config } = this.d;
    const groups = (await this.withGroup(() => redis.call('XINFO', 'GROUPS', config.stream))) as
      (string | number)[][] | null;
    for (const g of groups ?? []) {
      const rec: Record<string, string | number> = {};
      for (let i = 0; i + 1 < g.length; i += 2) rec[String(g[i])] = g[i + 1]!;
      if (rec.name === config.group) {
        return { lag: Number(rec.lag ?? 0), pending: Number(rec.pending ?? 0) };
      }
    }
    return null;
  }
}
