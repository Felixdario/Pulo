import { uuidv7 } from '@encurtador/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { COUNTRIES, metricValue, setup, UA, visitorId, type EventInput } from './helpers';

const t = setup();
const { sql } = t;

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.teardown();
});

/** Totais dos agregados (o teste pode contar na bruta; o produto não). */
async function totals() {
  const [raw] = await sql<
    { total: string; humans: string; bots: string; previews: string; uniq: string }[]
  >`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE kind = 'human') AS humans,
           count(*) FILTER (WHERE kind = 'bot') AS bots,
           count(*) FILTER (WHERE kind = 'preview') AS previews,
           (SELECT count(*) FROM (SELECT DISTINCT link_id, (occurred_at AT TIME ZONE 'UTC')::date, visitor
                                   FROM clicks WHERE kind = 'human') d) AS uniq
    FROM clicks`;
  const [hourly] = await sql`
    SELECT coalesce(sum(total), 0) AS total, coalesce(sum(humans), 0) AS humans,
           coalesce(sum(bots), 0) AS bots, coalesce(sum(previews), 0) AS previews FROM clicks_hourly`;
  const [daily] = await sql`
    SELECT coalesce(sum(total), 0) AS total, coalesce(sum(humans), 0) AS humans,
           coalesce(sum(bots), 0) AS bots, coalesce(sum(previews), 0) AS previews,
           coalesce(sum(uniques), 0) AS uniques FROM clicks_daily`;
  const dims = await sql<{ dim: string; n: string }[]>`
    SELECT dim, sum(n) AS n FROM clicks_daily_dim GROUP BY dim ORDER BY dim`;
  const [prev] = await sql`SELECT coalesce(sum(n), 0) AS n FROM clicks_daily_preview`;
  const [visitors] = await sql`SELECT count(*) AS n FROM click_visitors`;
  const [counts] = await sql`SELECT coalesce(sum(click_count), 0) AS n FROM links`;
  type Key = 'total' | 'humans' | 'bots' | 'previews' | 'uniq' | 'uniques';
  const num = (o: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, Number(v)])) as Record<
      Key,
      number
    >;
  return {
    raw: num(raw),
    hourly: num(hourly),
    daily: num(daily),
    dims: Object.fromEntries(dims.map((d) => [d.dim, Number(d.n)])),
    previews: Number(prev?.n),
    visitors: Number(visitors?.n),
    clickCount: Number(counts?.n),
  };
}

function expectConsistent(s: Awaited<ReturnType<typeof totals>>) {
  for (const k of ['total', 'humans', 'bots', 'previews'] as const) {
    expect(s.hourly[k], `hourly.${k}`).toBe(s.raw[k]);
    expect(s.daily[k], `daily.${k}`).toBe(s.raw[k]);
  }
  expect(s.daily.uniques).toBe(s.raw.uniq);
  expect(s.visitors).toBe(s.raw.uniq);
  expect(s.previews).toBe(s.raw.previews);
  expect(s.clickCount).toBe(s.raw.humans);
  for (const dim of ['country', 'city', 'referrer', 'browser', 'os', 'device']) {
    expect(s.dims[dim] ?? 0, `dim ${dim}`).toBe(s.raw.humans);
  }
}

describe('idempotência', () => {
  it('mesmo evento entregue 2× → 1 linha bruta e agregados +1', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    // Reentrega = os mesmos campos, inclusive o ts (que vira occurred_at, parte da chave).
    const ev: EventInput = {
      event_id: uuidv7(),
      ts: Date.now(),
      link_id: link!,
      visitor: visitorId(),
    };
    await t.publish(stream, [ev, ev]);
    const w = t.worker(stream);
    await w.start();
    await t.drained(stream);
    // E uma terceira vez, em outro lote.
    await t.publish(stream, [ev]);
    await t.drained(stream);
    const s = await totals();
    expect(s.raw.total).toBe(1);
    expect(s.hourly.total).toBe(1);
    expect(s.daily).toMatchObject({ total: 1, humans: 1, uniques: 1 });
    expect(s.clickCount).toBe(1);
    expectConsistent(s);
    expect(await metricValue(w, 'clicks_duplicates_total')).toBe(2);
    expect(await metricValue(w, 'clicks_processed_total', '{kind="human"}')).toBe(1);
  });

  it('crash entre o COMMIT e o XACK → após o XAUTOCLAIM, nenhum duplicado', async () => {
    const ids = await t.links(3);
    const stream = t.newStream();
    const events = Array.from({ length: 300 }, (_, i) => ({ link_id: ids[i % 3]! }));
    await t.publish(stream, events);

    let crashes = 0;
    const a = t.worker(
      stream,
      { consumer: 'morre' },
      {
        afterCommit: () => {
          crashes++;
          throw new Error('kill -9 simulado');
        },
      },
    );
    await a.start();
    for (let i = 0; i < 100 && crashes === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await a.stop();
    const before = await totals();
    expect(before.raw.total).toBeGreaterThan(0); // o lote foi gravado…
    const [pend] = (await t.redis.call('XPENDING', stream, 'workers')) as [number];
    expect(pend).toBe(before.raw.total); // …mas não confirmado

    const b = t.worker(stream, {
      consumer: 'sobrevive',
      reclaimIdleMs: 50,
      reclaimIntervalMs: 100,
    });
    await b.start();
    await t.drained(stream);
    const s = await totals();
    expect(s.raw.total).toBe(300);
    expectConsistent(s);
    expect(await metricValue(b, 'clicks_duplicates_total')).toBe(before.raw.total);
  });
});

describe('4 workers concorrentes', () => {
  it('100.000 eventos em 50 links e 10 países: agregados = bruta, únicos exatos, sem deadlock', async () => {
    const ids = await t.links(50, null);
    const stream = t.newStream();
    const now = Date.now();
    const pool = Array.from({ length: 4000 }, visitorId);
    let seed = 1;
    const rnd = () => {
      // LCG determinístico: o teste é reproduzível.
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const kinds = [
      UA.chrome,
      UA.iphone,
      UA.android,
      UA.chrome,
      UA.iphone,
      UA.android,
      UA.chrome,
      UA.iphone,
      UA.googlebot,
      UA.whatsapp,
    ];
    const refs = [
      '',
      'https://www.google.com/search?q=x',
      'https://t.co/abc',
      'android-app://com.google.android.gm',
    ];
    const events: EventInput[] = Array.from({ length: 100_000 }, () => ({
      link_id: ids[Math.floor(rnd() * 50)]!,
      ts: now - Math.floor(rnd() * 48 * 3600 * 1000),
      visitor: pool[Math.floor(rnd() * pool.length)]!,
      ip_net: `203.0.${Math.floor(rnd() * COUNTRIES.length)}.0`,
      ua: kinds[Math.floor(rnd() * kinds.length)]!,
      ref: refs[Math.floor(rnd() * refs.length)]!,
    }));
    await t.publish(stream, events);

    const workers = [1, 2, 3, 4].map((i) =>
      t.worker(stream, { consumer: `w${i}`, blockMs: 200, flushIntervalMs: 500 }),
    );
    const start = performance.now();
    await Promise.all(workers.map((w) => w.start()));
    await t.drained(stream, 'workers', 110_000);
    const seconds = (performance.now() - start) / 1000;
    await Promise.all(workers.map((w) => w.stop()));

    const s = await totals();
    let deadlocks = 0;
    let retries = 0;
    for (const w of workers) {
      deadlocks += await metricValue(w, 'batch_retries_total', '{reason="40P01"}');
      const body = await w.metrics.registry.metrics();
      retries += [...body.matchAll(/^batch_retries_total\{[^}]*\} (\d+)$/gm)].reduce(
        (a, m) => a + Number(m[1]),
        0,
      );
    }
    const perWorker = await Promise.all(
      workers.map(
        async (w) =>
          (await metricValue(w, 'clicks_processed_total', '{kind="human"}')) +
          (await metricValue(w, 'clicks_processed_total', '{kind="bot"}')) +
          (await metricValue(w, 'clicks_processed_total', '{kind="preview"}')),
      ),
    );
    console.log(
      JSON.stringify({
        events: 100_000,
        workers: 4,
        seconds: Number(seconds.toFixed(2)),
        eventsPerSecond: Math.round(100_000 / seconds),
        perWorker,
        deadlocks,
        retries,
        raw: s.raw,
      }),
    );

    expect(s.raw.total).toBe(100_000);
    expect(s.raw.humans + s.raw.bots + s.raw.previews).toBe(100_000);
    expect(s.raw.bots).toBeGreaterThan(5000);
    expect(s.raw.previews).toBeGreaterThan(5000);
    expectConsistent(s);
    expect(perWorker.every((n) => n > 0)).toBe(true); // os 4 trabalharam
    expect(deadlocks).toBe(0);

    // Países: os 10, e só de humanos.
    const countries = await sql<{ value: string; n: string }[]>`
      SELECT value, sum(n) AS n FROM clicks_daily_dim WHERE dim = 'country' GROUP BY value ORDER BY value`;
    expect(countries.map((c) => c.value).sort()).toEqual([...COUNTRIES].sort());
    const [maxDev] =
      await sql`SELECT count(DISTINCT value) AS n FROM clicks_daily_dim WHERE dim = 'device'`;
    expect(Number(maxDev!.n)).toBe(2); // desktop e mobile (robôs e prévias não entram)
  }, 180_000);
});

describe('throughput', () => {
  it('1 worker, lote de 1.000: 20.000 eventos', async () => {
    const ids = await t.links(20);
    const stream = t.newStream();
    await t.publish(
      stream,
      Array.from({ length: 20_000 }, (_, i) => ({
        link_id: ids[i % 20]!,
        ip_net: `203.0.${i % 10}.0`,
      })),
    );
    const w = t.worker(stream, { blockMs: 200, flushIntervalMs: 500 });
    const start = performance.now();
    await w.start();
    await t.drained(stream);
    const seconds = (performance.now() - start) / 1000;
    const body = await w.metrics.registry.metrics();
    const sum = Number(/^batch_duration_seconds_sum (\S+)$/m.exec(body)?.[1]);
    const count = Number(/^batch_duration_seconds_count (\S+)$/m.exec(body)?.[1]);
    console.log(
      JSON.stringify({
        events: 20_000,
        workers: 1,
        seconds: Number(seconds.toFixed(2)),
        eventsPerSecond: Math.round(20_000 / seconds),
        batches: count,
        avgBatchMs: Number(((sum / count) * 1000).toFixed(1)),
      }),
    );
    expect((await totals()).raw.total).toBe(20_000);
  }, 120_000);
});

describe('mensagens venenosas', () => {
  it('campo inválido → dead letter direto, exatamente 1 vez; o resto do lote segue', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    await t.publish(stream, [
      ...Array.from({ length: 5 }, () => ({ link_id: link! })),
      { link_id: 'abc' },
      { link_id: link!, visitor: 'curto' },
      ...Array.from({ length: 5 }, () => ({ link_id: link! })),
    ]);
    const w = t.worker(stream, { reclaimIdleMs: 30, reclaimIntervalMs: 60, maxDeliveries: 5 });
    await w.start();
    await t.drained(stream, 'workers', 20_000);
    await new Promise((r) => setTimeout(r, 300)); // vários ciclos de reclaim depois
    const s = await totals();
    expect(s.raw.total).toBe(10);
    expectConsistent(s);
    const dead = await t.redis.xrange(`${stream}:dead`, '-', '+');
    expect(dead).toHaveLength(2);
    const reasons = dead.map(([, fields]) => {
      const rec = Object.fromEntries(
        fields.flatMap((_, i, a) => (i % 2 === 0 ? [[a[i], a[i + 1]]] : [])),
      ) as Record<string, string>;
      expect(rec.original_id).toMatch(/^\d+-\d+$/);
      expect(rec.failures).toBe('1');
      return rec.reason;
    });
    expect(reasons.sort()).toEqual(['parse:link_id', 'parse:visitor']);
    expect(await metricValue(w, 'clicks_dead_total')).toBe(2);
    expect(await metricValue(w, 'clicks_invalid_total')).toBe(2);
  });

  it('evento de link inexistente é descartado sem travar o lote', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    await t.publish(stream, [{ link_id: link! }, { link_id: 999_999 }, { link_id: link! }]);
    const w = t.worker(stream);
    await w.start();
    await t.drained(stream);
    expect((await totals()).raw.total).toBe(2);
    expect(await metricValue(w, 'clicks_unknown_link_total')).toBe(1);
    expect(await metricValue(w, 'clicks_duplicates_total')).toBe(0);
  });
});

describe('classificação', () => {
  it('WhatsApp/Slack/facebookexternalhit → preview; isbot → bot; fora das dimensões e dos únicos', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    const shared = visitorId();
    await t.publish(stream, [
      { link_id: link!, ua: UA.whatsapp, visitor: shared },
      { link_id: link!, ua: UA.slack, visitor: shared },
      { link_id: link!, ua: UA.facebook },
      { link_id: link!, ua: UA.googlebot },
      { link_id: link!, ua: UA.curl },
      { link_id: link!, ua: '', kind_hint: 'bot' },
      { link_id: link!, ua: UA.iphone, visitor: shared },
      { link_id: link!, ua: UA.chrome },
    ]);
    const w = t.worker(stream);
    await w.start();
    await t.drained(stream);
    const kinds =
      await sql`SELECT kind, preview_app, count(*)::int AS n FROM clicks GROUP BY 1, 2 ORDER BY 1, 2`;
    expect(kinds.map((k) => [k.kind, k.preview_app, k.n])).toEqual([
      ['bot', null, 3],
      ['human', null, 2],
      ['preview', 'facebook', 1],
      ['preview', 'slack', 1],
      ['preview', 'whatsapp', 1],
    ]);
    const s = await totals();
    expectConsistent(s);
    expect(s.daily).toMatchObject({ total: 8, humans: 2, uniques: 2, bots: 3, previews: 3 });
    const prev = await sql`SELECT app, n::int FROM clicks_daily_preview ORDER BY app`;
    expect(prev.map((p) => [p.app, p.n])).toEqual([
      ['facebook', 1],
      ['slack', 1],
      ['whatsapp', 1],
    ]);
    // O visitante compartilhado só conta como único pela visita humana.
    const [v] = await sql`SELECT count(*)::int AS n FROM click_visitors WHERE visitor = ${shared}`;
    expect(v!.n).toBe(1);
  });

  it('referrer: caminho descartado, www. removido, vazio → (direto), android-app → app:…', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    await t.publish(stream, [
      { link_id: link!, ref: '' },
      { link_id: link!, ref: 'https://www.Google.com/search?q=segredo' },
      { link_id: link!, ref: 'https://news.example/caminho/privado?token=abc#x' },
      { link_id: link!, ref: 'android-app://com.google.android.gm' },
      { link_id: link!, ref: 'android-app://com.exemplo.app' },
    ]);
    const w = t.worker(stream);
    await w.start();
    await t.drained(stream);
    const refs =
      await sql`SELECT value FROM clicks_daily_dim WHERE dim = 'referrer' ORDER BY value`;
    expect(refs.map((r) => r.value)).toEqual([
      '(direto)',
      'app:com.exemplo.app',
      'app:gmail',
      'google.com',
      'news.example',
    ]);
    const [leak] = await sql`
      SELECT count(*)::int AS n FROM clicks WHERE referrer_domain LIKE '%/%' OR referrer_domain LIKE '%?%'`;
    expect(leak!.n).toBe(0);
  });
});

describe('schema e partições', () => {
  it('nenhuma coluna com "ip" no nome, em nenhuma tabela', async () => {
    const cols = await sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%ip%'`;
    expect(cols).toEqual([]);
    const [n] = await sql`
      SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public'`;
    expect(n!.n).toBeGreaterThan(40); // a consulta está mesmo olhando as tabelas
  });

  it('partições: o worker garante mês corrente e próximo; a DEFAULT recebe o resto', async () => {
    const stream = t.newStream();
    const w = t.worker(stream);
    await w.start();
    const now = new Date();
    const name = (d: Date) =>
      `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    for (const table of ['clicks', 'click_visitors']) {
      for (const d of [now, next]) {
        const [r] = await sql`SELECT to_regclass(${`${table}_p${name(d)}`}) AS t`;
        expect(r!.t, `${table}_p${name(d)}`).not.toBeNull();
      }
    }
    // Evento de 2021 (sem partição própria) vai para a DEFAULT e conta igual.
    const [link] = await t.links(1);
    await t.publish(stream, [{ link_id: link!, ts: Date.UTC(2021, 5, 1) }]);
    await t.drained(stream);
    const [p] = await sql`SELECT tableoid::regclass::text AS part FROM clicks`;
    expect(p!.part).toBe('clicks_default');
    expectConsistent(await totals());
  });

  it('retenção: drop_old_click_partitions(12) apaga a bruta antiga e mantém os agregados', async () => {
    const now = new Date();
    const month = (back: number) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const name = (d: Date) =>
      `clicks_p${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    // Corte com 12 meses = 1º dia de (mês corrente − 12). O mês −13 termina no corte: sai.
    // O mês −12 termina depois do corte: fica. O −14 e o −13 têm partição própria.
    const [old, edge, kept] = [month(14), month(13), month(12)];
    const existed = new Set<string>();
    for (const d of [old, edge, kept]) {
      const [r] = await sql`SELECT to_regclass(${name(d)}) AS t`;
      if (r!.t) existed.add(name(d));
    }
    try {
      await sql`SELECT ensure_click_partitions(${old.toISOString().slice(0, 10)}::date, ${kept
        .toISOString()
        .slice(0, 10)}::date)`;
      const stream = t.newStream();
      const off = t.worker(stream);
      await off.start();
      const [link] = await t.links(1);
      const mid = (d: Date) => d.getTime() + 10 * 86_400_000;
      await t.publish(stream, [
        { link_id: link!, ts: mid(old) },
        { link_id: link!, ts: mid(edge) },
        { link_id: link!, ts: mid(kept) },
        // Na DEFAULT (meses sem partição própria): um antes do corte (sai) e um depois (fica).
        { link_id: link!, ts: mid(month(16)) },
        { link_id: link!, ts: mid(month(11)) },
      ]);
      await t.drained(stream);
      const before = await totals();
      expect(before.raw.total).toBe(5);

      // Desligada por padrão: CLICK_RETENTION_MONTHS vazio não apaga nada.
      expect(loadConfig({}).clickRetentionMonths).toBeNull();
      expect(loadConfig({ CLICK_RETENTION_MONTHS: ' ' }).clickRetentionMonths).toBeNull();
      expect(loadConfig({ CLICK_RETENTION_MONTHS: '12' }).clickRetentionMonths).toBe(12);
      expect(() => loadConfig({ CLICK_RETENTION_MONTHS: '0' })).toThrow(/inteiro inválido/);
      expect(await off.retention()).toBe(0);
      expect((await totals()).raw.total).toBe(5);
      await off.stop();

      const on = t.worker(stream, { clickRetentionMonths: 12 });
      expect(await on.retention()).toBe(2);
      for (const d of [old, edge]) {
        const [r] = await sql`SELECT to_regclass(${name(d)}) AS t`;
        expect(r!.t, name(d)).toBeNull();
      }
      const [k] = await sql`SELECT to_regclass(${name(kept)}) AS t`;
      expect(k!.t).not.toBeNull();
      const rows = await sql<{ ms: string }[]>`
        SELECT (extract(epoch FROM occurred_at) * 1000)::bigint AS ms FROM clicks ORDER BY 1`;
      expect(rows.map((r) => Number(r.ms))).toEqual([mid(kept), mid(month(11))]);
      // Os agregados (fonte do painel, ADR 0006) não mudam.
      const after = await totals();
      expect(after.daily).toEqual(before.daily);
      expect(after.hourly).toEqual(before.hourly);
      expect(after.clickCount).toBe(5);
      // Idempotente; e 0 meses é recusado.
      expect(await on.retention()).toBe(0);
      await expect(sql`SELECT drop_old_click_partitions(0)`).rejects.toThrow(/keep_months/);
    } finally {
      for (const d of [old, edge, kept]) {
        if (!existed.has(name(d))) await sql.unsafe(`DROP TABLE IF EXISTS "${name(d)}"`);
      }
    }
  });
});

describe('ao vivo', () => {
  it('publica o lote em <LIVE_CHANNEL_PREFIX><user_id>', async () => {
    const prefix = `test-live-${process.pid}-${Date.now()}:`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash) VALUES (${`live-${Date.now()}@teste.dev`}, 'x')
      RETURNING id`;
    const userId = Number(user!.id);
    const [link] = await t.links(1, userId);
    const sub = new Redis(t.redisUrl);
    const got: { channel: string; message: string }[] = [];
    sub.on('message', (channel: string, message: string) => got.push({ channel, message }));
    try {
      await sub.subscribe(`${prefix}${userId}`, `live:${userId}`);
      const stream = t.newStream();
      const w = t.worker(stream, { liveChannelPrefix: prefix });
      await w.start();
      await t.publish(stream, [{ link_id: link! }, { link_id: link!, ua: UA.googlebot }]);
      await t.drained(stream);
      await expect.poll(() => got.length, { timeout: 3000 }).toBeGreaterThan(0);
      expect(got.every((g) => g.channel === `${prefix}${userId}`)).toBe(true);
      const sum = got
        .map((g) => JSON.parse(g.message) as { link_id: number; humans: number; total: number })
        .reduce((a, m) => ({ humans: a.humans + m.humans, total: a.total + m.total }), {
          humans: 0,
          total: 0,
        });
      expect(sum).toEqual({ humans: 1, total: 2 });
    } finally {
      sub.disconnect();
    }
  });
});

describe('encerramento', () => {
  it('stop no meio do fluxo: termina o lote, não perde nem duplica', async () => {
    const ids = await t.links(5);
    const stream = t.newStream();
    await t.publish(
      stream,
      Array.from({ length: 5000 }, (_, i) => ({ link_id: ids[i % 5]! })),
    );
    const a = t.worker(stream, { consumer: 'a', batchSize: 500 });
    await a.start();
    await new Promise((r) => setTimeout(r, 150));
    await a.stop();
    const [pend] = (await t.redis.call('XPENDING', stream, 'workers')) as [number];
    expect(pend).toBe(0); // o que foi lido foi gravado e confirmado
    const b = t.worker(stream, { consumer: 'b' });
    await b.start();
    await t.drained(stream);
    const s = await totals();
    expect(s.raw.total).toBe(5000);
    expectConsistent(s);
  });
});
