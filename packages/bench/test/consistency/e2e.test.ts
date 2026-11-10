import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { resolveTestRedisUrl } from '@encurtador/db/testing';
import { createMemoryGeoLookup } from '@encurtador/geo';
import { uuidv7 } from '@encurtador/shared';
import { loadConfig } from '@encurtador/worker/config';
import { ClickWorker } from '@encurtador/worker/worker';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { benchSql, readMeta, type BenchMeta } from '../../src/bench-db';
import { mulberry32 } from '../../src/profile';
import { allChecks, dayScope, linkScope, totals } from './checks';

/**
 * Ponta a ponta sobre o bench: eventos sintéticos publicados no stream (Redis db 1, o de teste, num
 * stream só deste teste) e processados pelo `ClickWorker` real contra o `encurtador_bench`, por cima
 * dos agregados que o `rebuild_aggregates` derivou da bruta. Se as duas semânticas não fossem a
 * mesma (únicos, dimensões, click_count…), a consistência quebraria aqui.
 *
 * Inclui visitantes que **já existem** na bruta naquele link e dia (não podem contar como únicos
 * novos), eventos repetidos (mesmo event_id: não podem contar duas vezes), robôs, prévias, links
 * quentes, frios e com 0 cliques, e dias passados (até 6 dias atrás) além de hoje.
 */
const N = Number(process.env.CONSISTENCY_E2E_EVENTS ?? 3000);
const DUPLICATES = Math.floor(N / 10);
const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'WhatsApp/2.23.20.0 A',
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
];
const REFS = [
  '',
  'https://www.google.com/search?q=x',
  'https://t.co/abc',
  'android-app://com.google.android.gm',
];
const geo = createMemoryGeoLookup({
  '203.0.113.0': { country: 'BR', city: 'São Paulo', region: 'São Paulo' },
  '198.51.100.0': { country: 'US', city: 'New York', region: 'New York' },
  '192.0.2.0': { country: 'PT', city: 'Lisboa', region: 'Lisboa' },
});
const NETS = ['203.0.113.0', '198.51.100.0', '192.0.2.0', '10.9.9.0'];

let sql: Sql;
let meta: BenchMeta;
let redis: Redis;
const stream = `bench:consistency:${process.pid}:${Date.now()}`;

beforeAll(async () => {
  sql = await benchSql({
    max: 6,
    params: { work_mem: '256MB', application_name: 'consistency-e2e' },
  });
  meta = await readMeta(sql);
  redis = new Redis(resolveTestRedisUrl());
});

afterAll(async () => {
  await redis?.del(stream, `${stream}:dead`, `${stream}:fails`);
  redis?.disconnect();
  await sql?.end({ timeout: 5 });
});

describe('ponta a ponta: stream → worker real → encurtador_bench', () => {
  it(`${N} eventos + ${DUPLICATES} repetidos: bruta cresce exatamente N e tudo continua batendo`, async () => {
    const rnd = mulberry32(Date.now() % 1_000_000);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const zero = await sql<{ id: string }[]>`
      SELECT id FROM links l WHERE NOT EXISTS (SELECT 1 FROM clicks c WHERE c.link_id = l.id)
      ORDER BY id LIMIT 2`;
    const random = await sql<{ id: string }[]>`SELECT id FROM links ORDER BY random() LIMIT 20`;
    const links = [
      meta.hotLink,
      meta.coldLink,
      ...zero.map((r) => Number(r.id)),
      ...random.map((r) => Number(r.id)),
    ];
    // Visitantes que já clicaram no link quente ontem e anteontem: reaparecem no mesmo dia UTC.
    const known = await sql<{ visitor: string; day: string }[]>`
      SELECT DISTINCT visitor, to_char((occurred_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day
      FROM clicks
      WHERE link_id = ${meta.hotLink} AND kind = 'human'
        AND occurred_at >= now() - interval '2 days' AND occurred_at < date_trunc('day', now(), 'UTC')
      LIMIT 200`;

    const now = Date.now();
    const events: string[][] = [];
    for (let i = 0; i < N; i++) {
      let link = pick(links);
      let ts =
        rnd() < 0.7
          ? now - Math.floor(rnd() * 3_600_000)
          : now - Math.floor(rnd() * 6 * 86_400_000);
      let visitor = randomBytes(16).toString('base64url').slice(0, 22);
      if (known.length > 0 && rnd() < 0.15) {
        const k = pick(known);
        link = meta.hotLink;
        visitor = k.visitor;
        ts = Date.parse(`${k.day}T12:00:00Z`) + Math.floor(rnd() * 3_600_000);
      }
      events.push([
        'event_id',
        uuidv7(ts),
        'link_id',
        String(link),
        'ts',
        String(ts),
        'visitor',
        visitor,
        'ip_net',
        pick(NETS),
        'ua',
        pick(UA),
        'ref',
        pick(REFS),
        'country',
        '',
        'kind_hint',
        'human',
      ]);
    }
    for (let i = 0; i < DUPLICATES; i++) events.push(events[Math.floor(rnd() * N)]!);

    const [before] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM clicks`;
    for (let i = 0; i < events.length; i += 2000) {
      const p = redis.pipeline();
      for (const e of events.slice(i, i + 2000)) p.xadd(stream, '*', ...e);
      await p.exec();
    }

    const blocking = new Redis(resolveTestRedisUrl());
    const own = new Redis(resolveTestRedisUrl());
    const log = pino({ level: 'warn' }, new Writable({ write: (_c, _e, cb) => cb() }));
    const worker = new ClickWorker({
      sql,
      redis: own,
      blockingRedis: blocking,
      geo,
      log,
      config: {
        ...loadConfig({}),
        stream,
        // Canal do ao vivo só deste teste: com o `live:` padrão, uma aba do dev aberta no usuário de
        // mesmo id receberia os cliques sintéticos (o Pub/Sub do Redis ignora o db).
        liveChannelPrefix: `bench-consistency-${process.pid}:`,
        consumer: 'consistency',
        blockMs: 100,
        flushIntervalMs: 100,
      },
    });
    await worker.start();
    const t0 = Date.now();
    for (;;) {
      const groups = (await redis.call('XINFO', 'GROUPS', stream)) as (string | number)[][];
      const g = groups.map((x) =>
        Object.fromEntries(x.flatMap((v, j) => (j % 2 ? [] : [[v, x[j + 1]]]))),
      )[0];
      if (g && Number(g.lag) === 0 && Number(g.pending) === 0) break;
      if (Date.now() - t0 > 120_000) throw new Error(`stream não drenou: ${JSON.stringify(g)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.stop();
    blocking.disconnect();
    own.disconnect();

    const [after] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM clicks`;
    expect(Number(after!.n) - Number(before!.n)).toBe(N);
    expect(await redis.xlen(`${stream}:dead`)).toBe(0);

    const days = [...new Set(events.map((e) => new Date(Number(e[5])).toISOString().slice(0, 10)))];
    expect(await allChecks(sql, linkScope(links), links)).toEqual([]);
    expect(await allChecks(sql, dayScope(days))).toEqual([]);
    const t = await totals(sql);
    expect(t.daily_total).toBe(t.raw_total);
    expect(t.hourly_total).toBe(t.raw_total);
    expect(t.click_count).toBe(t.raw_humans);
    expect(t.dim_min).toBe(t.raw_humans);
    expect(t.dim_max).toBe(t.raw_humans);
  }, 300_000);
});
