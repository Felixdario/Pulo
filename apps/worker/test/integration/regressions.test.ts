/**
 * Regressões dos ataques do Validador independente da fase 3 (rodada 1). Cada teste reproduz um
 * cenário que quebrava o pipeline e prova a correção.
 */
import { createMemoryGeoLookup } from '@encurtador/geo';
import { uuidv7 } from '@encurtador/shared';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { COUNTRIES, metricValue, setup, visitorId } from './helpers';

const t = setup();
const { sql } = t;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.teardown();
});

async function sums() {
  const [r] = await sql<
    { raw: number; hourly: number; daily: number; uniques: number; cc: number; uniq: number }[]
  >`
    SELECT (SELECT count(*)::int FROM clicks) AS raw,
           (SELECT coalesce(sum(total), 0)::int FROM clicks_hourly) AS hourly,
           (SELECT coalesce(sum(total), 0)::int FROM clicks_daily) AS daily,
           (SELECT coalesce(sum(uniques), 0)::int FROM clicks_daily) AS uniques,
           (SELECT coalesce(sum(click_count), 0)::int FROM links) AS cc,
           (SELECT count(*)::int FROM (SELECT DISTINCT link_id, (occurred_at AT TIME ZONE 'UTC')::date,
              visitor FROM clicks WHERE kind = 'human') d) AS uniq`;
  return r!;
}

/** Segura um lock exclusivo numa tabela até `release()`. */
async function lockTable(table: string) {
  const locker = postgres(inject('testDatabaseUrl'), { max: 1, onnotice: () => {} });
  const reserved = await locker.reserve();
  await reserved`BEGIN`;
  await reserved.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
  return async () => {
    await reserved`COMMIT`;
    reserved.release();
    await locker.end();
  };
}

describe('dead letter só por falha real (validador D e G)', () => {
  it('Postgres travado 3 s num agregado, reclaim agressivo, 2 workers → 0 em :dead, contagens exatas', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    const release = await lockTable('clicks_daily_dim');
    try {
      await t.publish(
        stream,
        Array.from({ length: 10 }, () => ({ link_id: link! })),
      );
      const ws = [1, 2].map((i) =>
        t.worker(stream, {
          consumer: `lento${i}`,
          reclaimIdleMs: 50,
          reclaimIntervalMs: 100,
          maxDeliveries: 5,
        }),
      );
      await Promise.all(ws.map((w) => w.start()));
      await sleep(3000);
      expect(await t.redis.xlen(`${stream}:dead`)).toBe(0);
      expect((await sums()).raw).toBe(0); // nada gravado durante a trava
    } finally {
      await release();
    }
    await t.drained(stream, 'workers', 20_000);
    await sleep(300);
    expect(await t.redis.xlen(`${stream}:dead`)).toBe(0);
    const s = await sums();
    expect(s).toMatchObject({ raw: 10, hourly: 10, daily: 10, cc: 10, uniques: 10 });
  });

  it('4 workers, reclaim a cada 5 ms com idle de 1 ms, 3.000 eventos no mesmo link → :dead vazio, exato', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    const ts = Date.now();
    await t.publish(
      stream,
      Array.from({ length: 3000 }, (_, i) => ({
        link_id: link!,
        ts: ts + (i % 10),
        visitor: i % 3 === 0 ? 'AAAAAAAAAAAAAAAAAAAAAA' : visitorId(),
      })),
    );
    const ws = [1, 2, 3, 4].map((i) =>
      t.worker(stream, {
        consumer: `g${i}`,
        reclaimIdleMs: 1,
        reclaimIntervalMs: 5,
        batchSize: 1000,
      }),
    );
    await Promise.all(ws.map((w) => w.start()));
    await t.drained(stream, 'workers', 60_000);
    await sleep(500);
    expect(await t.redis.xlen(`${stream}:dead`)).toBe(0);
    const s = await sums();
    expect(s).toMatchObject({ raw: 3000, hourly: 3000, daily: 3000, cc: 3000 });
    expect(s.uniques).toBe(s.uniq);
    let dead = 0;
    for (const w of ws) dead += await metricValue(w, 'clicks_dead_total');
    expect(dead).toBe(0);
  });

  it('erro de dado do Postgres → :dead após 5 falhas, exatamente 1 vez; o resto segue', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    // A base de geo devolve uma cidade com NUL, que o Postgres recusa (22021) só para este evento.
    const geo = createMemoryGeoLookup({
      '203.0.0.0': { country: 'BR', city: 'Cidade-BR' },
      '203.0.9.0': { country: 'ZA', city: 'Cape\u0000Town' },
    });
    await t.publish(stream, [
      { link_id: link! },
      { link_id: link!, ip_net: '203.0.9.0' },
      { link_id: link! },
      { link_id: link! },
    ]);
    const ws = [1, 2].map((i) =>
      t.worker(
        stream,
        { consumer: `d${i}`, reclaimIdleMs: 30, reclaimIntervalMs: 60, maxDeliveries: 5 },
        { geo },
      ),
    );
    await Promise.all(ws.map((w) => w.start()));
    await t.drained(stream, 'workers', 30_000);
    await sleep(300);
    expect((await sums()).raw).toBe(3);
    const dead = await t.redis.xrange(`${stream}:dead`, '-', '+');
    expect(dead).toHaveLength(1);
    const rec = Object.fromEntries(
      dead[0]![1].flatMap((_, i, a) => (i % 2 === 0 ? [[a[i], a[i + 1]]] : [])),
    ) as Record<string, string>;
    expect(rec.reason).toMatch(/^db:22/);
    expect(rec.failures).toBe('5');
    expect(await t.redis.hlen(`${stream}:fails`)).toBe(0);
  });
});

describe('occurred_at preso ao event_id (validador A)', () => {
  it('mesmo event_id com ts agora / +1 ms / −40 dias → 1 linha, agregados +1', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    const now = Date.now();
    const id = uuidv7(now);
    await t.publish(stream, [
      { event_id: id, link_id: link!, ts: now },
      { event_id: id, link_id: link!, ts: now + 1 },
      { event_id: id, link_id: link!, ts: now - 40 * 86_400_000 },
    ]);
    const w = t.worker(stream);
    await w.start();
    await t.drained(stream);
    expect(await sums()).toMatchObject({ raw: 1, hourly: 1, daily: 1, uniques: 1, cc: 1 });
    const [row] =
      await sql`SELECT (extract(epoch FROM occurred_at) * 1000)::bigint::text AS ms FROM clicks`;
    expect(Number(row!.ms)).toBe(now); // o tempo do UUIDv7, não o ts de −40 dias
    expect(await metricValue(w, 'clicks_ts_mismatch_total')).toBe(1);
    expect(await metricValue(w, 'clicks_duplicates_total')).toBe(2);
  });

  it('event_id que não é UUIDv7 → dead letter', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    await t.publish(stream, [
      { event_id: '0190c6e1-7a2b-4c3d-8e4f-0123456789ab', link_id: link! },
      { link_id: link! },
    ]);
    const w = t.worker(stream);
    await w.start();
    await t.drained(stream);
    expect((await sums()).raw).toBe(1);
    expect(await t.redis.xlen(`${stream}:dead`)).toBe(1);
  });
});

describe('stream ou grupo apagado (validador E)', () => {
  it('DEL do stream com o worker rodando → grupo recriado e os 5 eventos novos processados', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    await t.publish(stream, [{ link_id: link! }]);
    const w = t.worker(stream, { reclaimIdleMs: 50, reclaimIntervalMs: 100 });
    await w.start();
    await t.drained(stream);
    await t.redis.del(stream);
    await sleep(300); // o XREADGROUP bate em NOGROUP e recria o grupo (com MKSTREAM)
    await t.publish(
      stream,
      Array.from({ length: 5 }, () => ({ link_id: link! })),
    );
    await t.drained(stream, 'workers', 10_000);
    expect((await sums()).raw).toBe(6);
    expect(await w.streamInfo()).toEqual({ lag: 0, pending: 0 });
  });

  it('DEL antes de qualquer leitura nova também funciona (XADD recria o stream sem grupo)', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    const w = t.worker(stream, { reclaimIdleMs: 50, reclaimIntervalMs: 100 });
    await w.start();
    await t.redis.del(stream);
    await t.publish(
      stream,
      Array.from({ length: 5 }, () => ({ link_id: link! })),
    );
    await t.drained(stream, 'workers', 10_000).catch(async () => {
      // O grupo pode ainda não existir: o drained só olha grupos existentes.
      await sleep(1000);
      await t.drained(stream, 'workers', 10_000);
    });
    expect((await sums()).raw).toBe(5);
    expect(t.logs.some((l) => l.includes('recriando'))).toBe(true);
  });
});

describe('link apagado (validador F)', () => {
  it('conta como link desconhecido, não como duplicata', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    await t.publish(stream, [{ link_id: link! }, { link_id: link! }]);
    await sql`DELETE FROM links WHERE id = ${link!}`;
    const w = t.worker(stream);
    await w.start();
    await t.drained(stream);
    expect((await sums()).raw).toBe(0);
    expect(await metricValue(w, 'clicks_unknown_link_total')).toBe(2);
    expect(await metricValue(w, 'clicks_duplicates_total')).toBe(0);
  });
});

describe('encerramento com Postgres preso', () => {
  it('stop() respeita o prazo sem XACK; outro worker completa sem duplicar', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    const release = await lockTable('clicks_hourly');
    let elapsed: number;
    try {
      await t.publish(
        stream,
        Array.from({ length: 5 }, () => ({ link_id: link! })),
      );
      const a = t.worker(stream, { consumer: 'preso', stopTimeoutMs: 500 });
      await a.start();
      await sleep(300);
      const start = performance.now();
      await a.stop();
      elapsed = performance.now() - start;
    } finally {
      await release();
    }
    expect(elapsed).toBeLessThan(1500);
    await sleep(200);
    const b = t.worker(stream, { consumer: 'livre', reclaimIdleMs: 50, reclaimIntervalMs: 100 });
    await b.start();
    await t.drained(stream, 'workers', 20_000);
    expect(await sums()).toMatchObject({ raw: 5, hourly: 5, daily: 5, cc: 5 });
  });
});

describe('país e referrer hostis (validador C)', () => {
  it('país pseudocódigo vira desconhecido; referrer IP vira (ip); android-app estranho vira (desconhecido)', async () => {
    const [link] = await t.links(1);
    const stream = t.newStream();
    await t.publish(stream, [
      { link_id: link!, country: 'XX', ip_net: '' },
      { link_id: link!, country: 'EU', ip_net: '' },
      { link_id: link!, country: 'br', ip_net: '' },
      { link_id: link!, ref: 'http://192.168.0.10/x' },
      { link_id: link!, ref: 'http://[2001:db8::1]:81/' },
      { link_id: link!, ref: 'android-app://joao:senha@com.x"y\\z,{q}' },
    ]);
    const w = t.worker(stream);
    await w.start();
    await t.drained(stream);
    const countries = await sql`
      SELECT value, sum(n)::int AS n FROM clicks_daily_dim WHERE dim = 'country' GROUP BY 1 ORDER BY value COLLATE "C"`;
    expect(countries.map((c) => [c.value, c.n])).toEqual([
      ['(desconhecido)', 2],
      ['BR', 4],
    ]);
    expect(COUNTRIES[0]).toBe('BR'); // as 3 sem país do evento caem no geo de 203.0.0.0 = BR
    const refs = await sql`
      SELECT value, sum(n)::int AS n FROM clicks_daily_dim WHERE dim = 'referrer' GROUP BY 1 ORDER BY value COLLATE "C"`;
    expect(refs.map((r) => [r.value, r.n])).toEqual([
      ['(desconhecido)', 1],
      ['(direto)', 3],
      ['(ip)', 2],
    ]);
  });
});
