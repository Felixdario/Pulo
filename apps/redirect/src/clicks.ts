import { createHmac, randomBytes } from 'node:crypto';
import { dailySalt, utcDay } from '@encurtador/db/cache';
import type { AgentKind } from '@encurtador/shared';
import { truncateIp, uuidv7 } from '@encurtador/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { Metrics } from './metrics';

/**
 * Sal do dia em memória (ele não muda durante o dia). Se o Redis estiver fora, usa um candidato
 * local e tenta de novo depois propondo o mesmo candidato com SET NX: se ninguém criou o sal do dia,
 * o nosso vira o oficial e os `visitor` já gerados continuam válidos.
 */
export class SaltProvider {
  private day = '';
  private candidate = '';
  private confirmed: string | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private readonly redis: Redis) {}

  get(now = new Date()): Promise<string> | string {
    const day = utcDay(now);
    if (day !== this.day) {
      this.day = day;
      this.candidate = randomBytes(32).toString('base64');
      this.confirmed = null;
      this.inflight = null;
    }
    if (this.confirmed) return this.confirmed;
    this.inflight ??= dailySalt(this.redis, day, this.candidate)
      .then((salt) => {
        if (this.day === day) this.confirmed = salt;
        return salt;
      })
      .catch(() => this.candidate)
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

export interface ClickInput {
  linkId: number;
  ip: string;
  ua: string | undefined;
  ref: string | undefined;
  country: string | null;
  kind: AgentKind;
}

/**
 * Campos do evento (ADR 0003). O IP completo entra aqui e sai como `visitor` (HMAC com o sal do dia)
 * e `ip_net` (truncado); nada guarda o IP bruto.
 */
export function clickFields(input: ClickInput, salt: string, now = Date.now()): string[] {
  const ua = (input.ua ?? '').slice(0, 512);
  const visitor = createHmac('sha256', salt)
    .update(`${input.ip}\u0000${ua}`)
    .digest('base64url')
    .slice(0, 22);
  return [
    'event_id',
    uuidv7(now),
    'link_id',
    String(input.linkId),
    'ts',
    String(now),
    'visitor',
    visitor,
    'ip_net',
    truncateIp(input.ip) ?? '',
    'ua',
    ua,
    'ref',
    (input.ref ?? '').slice(0, 1024),
    'country',
    input.country ?? '',
    'kind_hint',
    input.kind,
  ];
}

export interface PublisherOptions {
  stream: string;
  maxLen: number;
  bufferLimit: number;
  flushIntervalMs?: number;
}

/**
 * `XADD <stream> MAXLEN ~ N * …` sem await (ADR 0002, seção 6). Se o XADD falha, o evento vai para
 * um buffer em memória (até `bufferLimit`) que é reenviado periodicamente; o excedente é descartado
 * com métrica. Perder um clique é aceitável; atrasar o redirect, não.
 */
export class ClickPublisher {
  private readonly buffer: string[][] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(
    private readonly redis: Redis,
    private readonly opts: PublisherOptions,
    private readonly metrics: Metrics,
    private readonly log: FastifyBaseLogger,
  ) {}

  get buffered(): number {
    return this.buffer.length;
  }

  publish(fields: string[]): void {
    if (this.buffer.length > 0) {
      // Mantém a ordem: enquanto há atraso, tudo passa pelo buffer.
      this.enqueue(fields);
      return;
    }
    this.xadd(fields).catch(() => {
      this.metrics.publishFailed.inc();
      this.enqueue(fields);
    });
  }

  private xadd(fields: string[]): Promise<unknown> {
    const { stream, maxLen } = this.opts;
    return this.redis.xadd(stream, 'MAXLEN', '~', maxLen, '*', ...fields);
  }

  private enqueue(fields: string[]): void {
    if (this.buffer.length >= this.opts.bufferLimit) {
      this.metrics.dropped.inc();
      return;
    }
    this.buffer.push(fields);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.flushIntervalMs ?? 1000);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.slice(0, 500);
        const pipeline = this.redis.pipeline();
        for (const f of batch) {
          pipeline.xadd(this.opts.stream, 'MAXLEN', '~', this.opts.maxLen, '*', ...f);
        }
        const results = await pipeline.exec();
        if (!results || results.some(([err]) => err)) throw new Error('XADD do buffer falhou');
        this.buffer.splice(0, batch.length);
      }
    } catch {
      this.log.warn({ buffered: this.buffer.length }, 'redis indisponível; cliques no buffer');
      this.schedule();
    } finally {
      this.flushing = false;
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
