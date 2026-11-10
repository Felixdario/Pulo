import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { createDb, createLink } from '@encurtador/db';
import { flushTestRedis, resetTestDb, resolveTestRedisUrl } from '@encurtador/db/testing';
import { createMemoryGeoLookup, type GeoLookup } from '@encurtador/geo';
import { uuidv7 } from '@encurtador/shared';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { inject } from 'vitest';
import { loadConfig, type WorkerConfig } from '../../src/config';
import { ClickWorker, type WorkerDeps } from '../../src/worker';

export const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  whatsapp: 'WhatsApp/2.23.20.0 A',
  slack: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  facebook: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  curl: 'curl/8.4.0',
};

export const COUNTRIES = ['BR', 'US', 'PT', 'AR', 'MX', 'DE', 'FR', 'JP', 'IN', 'ZA'];
/** ip_net de teste → país (fake de geo). `203.0.<i>.0` = COUNTRIES[i]. */
export const testGeo: GeoLookup = createMemoryGeoLookup(
  Object.fromEntries(
    COUNTRIES.map((c, i) => [
      `203.0.${i}.0`,
      { country: c, city: `Cidade-${c}`, region: `Região-${c}` },
    ]),
  ),
);

export const visitorId = () => randomBytes(16).toString('base64url');

export interface EventInput {
  event_id?: string;
  link_id: number | string;
  ts?: number;
  visitor?: string;
  ip_net?: string;
  ua?: string;
  ref?: string;
  country?: string;
  kind_hint?: string;
}

export function eventFields(e: EventInput): string[] {
  const ts = e.ts ?? Date.now();
  const rec: Record<string, string> = {
    event_id: e.event_id ?? uuidv7(ts),
    link_id: String(e.link_id),
    ts: String(ts),
    visitor: e.visitor ?? visitorId(),
    ip_net: e.ip_net ?? '203.0.0.0',
    ua: e.ua ?? UA.chrome,
    ref: e.ref ?? '',
    country: e.country ?? '',
    kind_hint: e.kind_hint ?? 'human',
  };
  return Object.entries(rec).flat();
}

export function setup() {
  const { db, sql, close } = createDb(inject('testDatabaseUrl'), { max: 10 });
  const redisUrl = resolveTestRedisUrl();
  const redis = new Redis(redisUrl);
  const extra: { disconnect(): void }[] = [];
  const workers: ClickWorker[] = [];
  const logs: string[] = [];
  let streamSeq = 0;

  const log = pino(
    { level: 'info' },
    new Writable({
      write(chunk, _e, cb) {
        logs.push(String(chunk));
        if (process.env.WORKER_TEST_LOGS === '1') process.stderr.write(chunk);
        cb();
      },
    }),
  );

  function newStream() {
    streamSeq++;
    return `test:clicks:${process.pid}:${streamSeq}`;
  }

  function worker(
    stream: string,
    overrides: Partial<WorkerConfig> = {},
    deps: Partial<Pick<WorkerDeps, 'geo' | 'afterCommit'>> = {},
  ) {
    const blockingRedis = new Redis(redisUrl);
    const own = new Redis(redisUrl);
    extra.push(blockingRedis, own);
    const config: WorkerConfig = {
      ...loadConfig({}),
      stream,
      consumer: `c${workers.length + 1}`,
      blockMs: 100,
      flushIntervalMs: 100,
      ...overrides,
    };
    const w = new ClickWorker({
      sql,
      redis: own,
      blockingRedis,
      geo: deps.geo ?? testGeo,
      config,
      log,
      ...(deps.afterCommit ? { afterCommit: deps.afterCommit } : {}),
    });
    workers.push(w);
    return w;
  }

  async function publish(stream: string, events: EventInput[]) {
    for (let i = 0; i < events.length; i += 5000) {
      const p = redis.pipeline();
      for (const e of events.slice(i, i + 5000)) p.xadd(stream, '*', ...eventFields(e));
      await p.exec();
    }
  }

  /** Espera o grupo não ter nada por entregar nem pendente. */
  async function drained(stream: string, group = 'workers', timeoutMs = 60_000) {
    const start = Date.now();
    for (;;) {
      const groups = (await redis.call('XINFO', 'GROUPS', stream)) as (string | number)[][];
      const g = groups
        .map((x) => {
          const r: Record<string, string | number> = {};
          for (let i = 0; i + 1 < x.length; i += 2) r[String(x[i])] = x[i + 1]!;
          return r;
        })
        .find((r) => r.name === group);
      if (g && Number(g.lag) === 0 && Number(g.pending) === 0) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`stream não drenou: ${JSON.stringify(g)}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function links(n: number, userId: number | null = null) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push((await createLink(db, { destination: 'https://example.com/', userId })).id);
    }
    return out;
  }

  async function reset() {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
    for (const r of extra.splice(0)) r.disconnect();
    await flushTestRedis(redis);
    await resetTestDb(db);
    logs.length = 0;
  }

  async function teardown() {
    await reset();
    redis.disconnect();
    await close();
  }

  return {
    db,
    sql,
    redis,
    redisUrl,
    logs,
    log,
    newStream,
    worker,
    publish,
    drained,
    links,
    reset,
    teardown,
  };
}

export const metricValue = async (w: ClickWorker, name: string, labels = '') => {
  const body = await w.metrics.registry.metrics();
  const re = new RegExp(
    `^${name}${labels.replace(/[{}"]/g, (c) => `\\${c}`)} (\\d+(?:\\.\\d+)?)$`,
    'm',
  );
  return Number(re.exec(body)?.[1] ?? 0);
};
