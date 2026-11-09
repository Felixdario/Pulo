import { createDb } from '@encurtador/db';
import { SHARED_VERSION } from '@encurtador/shared';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig({ JWT_SECRET: 'x'.repeat(32) });

// Timeout maior: o boot do Fastify fica lento quando o pnpm -r roda os testes pesados em paralelo.
describe('redirect (sem serviços)', () => {
  it('GET /healthz responde 200 sem tocar em banco nem Redis', async () => {
    const { db, close } = createDb('postgres://u:p@localhost:1/x');
    const redis = new Redis({ lazyConnect: true });
    const app = buildApp({ db, redis, config });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', shared: SHARED_VERSION });
    await app.close();
    redis.disconnect();
    await close();
  }, 30_000);

  it('config: flags e validações', () => {
    expect(() => loadConfig({ JWT_SECRET: 'curto' })).toThrow(TypeError);
    // REDIRECT_SECRET vazio (como no .env.example) cai para o JWT_SECRET.
    expect(loadConfig({ REDIRECT_SECRET: '', JWT_SECRET: 'j'.repeat(32) }).secret).toBe(
      'j'.repeat(32),
    );
    expect(loadConfig({ REDIRECT_SECRET: 'r'.repeat(32), JWT_SECRET: 'j'.repeat(32) }).secret).toBe(
      'r'.repeat(32),
    );
    expect(() => loadConfig({ JWT_SECRET: 'x'.repeat(32), TRUST_PROXY: '10.0.0.0/99' })).toThrow(
      TypeError,
    );
    const c = loadConfig({
      JWT_SECRET: 'x'.repeat(32),
      CACHE: 'off',
      RATE_LIMIT: 'OFF',
      REDIS_ROUNDTRIPS: '2',
      TRUST_PROXY: '10.0.0.0/8, 127.0.0.1',
      NODE_ENV: 'production',
    });
    expect(c).toMatchObject({
      cache: false,
      rateLimit: false,
      redisRoundTrips: 2,
      trustProxy: ['10.0.0.0/8', '127.0.0.1'],
      secureCookies: true,
      logLevel: 'warn',
      bucket: { capacity: 60, refillPerSecond: 10 },
    });
    expect(config).toMatchObject({ cache: true, rateLimit: true, secureCookies: false });
  });
});
