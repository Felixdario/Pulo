import { Writable } from 'node:stream';
import { createDb, type Database } from '@encurtador/db';
import { flushTestRedis, resetTestDb, resolveTestRedisUrl } from '@encurtador/db/testing';
import { Redis } from 'ioredis';
import { inject } from 'vitest';
import { buildApp, type RedirectDeps } from '../../src/app';
import { loadConfig, type RedirectConfig } from '../../src/config';

export const UA = {
  chrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  whatsapp: 'WhatsApp/2.23.20.0 A',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

export const SECRET = 'segredo-de-teste-com-pelo-menos-32-caracteres';

export function setup() {
  const queries: string[] = [];
  const { db, close } = createDb(inject('testDatabaseUrl'), {
    max: 20,
    onQuery: (q) => queries.push(q),
  });
  const redis = new Redis(resolveTestRedisUrl());
  const apps: { close(): Promise<unknown> }[] = [];
  const logs: string[] = [];

  /** Quantos SELECT na tabela links desde o último reset. */
  const linkSelects = () =>
    queries.filter((q) => /^\s*select/i.test(q) && q.includes('"links"')).length;

  function config(overrides: Partial<RedirectConfig> = {}): RedirectConfig {
    return {
      ...loadConfig({ JWT_SECRET: SECRET, LOG_LEVEL: 'info' }),
      // Capacidade alta por padrão: só o teste do bucket usa os valores do ADR.
      bucket: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
      ...overrides,
    };
  }

  function app(overrides: Partial<RedirectConfig> = {}, deps: Partial<RedirectDeps> = {}) {
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    });
    const a = buildApp({ db, redis, config: config(overrides), logStream, ...deps });
    apps.push(a);
    return a;
  }

  async function reset() {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    await flushTestRedis(redis);
    await resetTestDb(db);
    queries.length = 0;
    logs.length = 0;
  }

  async function teardown() {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    redis.disconnect();
    await close();
  }

  /** Espera o stream ter `n` eventos (o XADD sai depois da resposta). */
  async function events(n: number, stream = 'clicks', timeoutMs = 3000) {
    const start = Date.now();
    for (;;) {
      const entries = await redis.xrange(stream, '-', '+');
      if (entries.length >= n || Date.now() - start > timeoutMs) {
        return entries.map(([id, fields]) => {
          const obj: Record<string, string> = { id };
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]!] = fields[i + 1]!;
          return obj as Record<string, string> & { id: string };
        });
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  return {
    db: db as Database,
    redis,
    queries,
    logs,
    linkSelects,
    config,
    app,
    reset,
    teardown,
    events,
  };
}

/** Proxy que conta (e opcionalmente troca) chamadas de método no cliente Redis. */
export function spyRedis(
  target: Redis,
  overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {},
) {
  const calls: string[] = [];
  const redis = new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        const fn = overrides[String(prop)] ?? (value as (...a: unknown[]) => unknown);
        return fn.apply(t, args);
      };
    },
  });
  return { redis, calls };
}
