import { createDb, type Database } from '@encurtador/db';
import { flushTestRedis, resetTestDb, resolveTestRedisUrl } from '@encurtador/db/testing';
import type { LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { expect, inject } from 'vitest';
import { buildApp, type ApiApp, type ApiDeps } from '../../src/app';
import { loadConfig, type ApiConfig } from '../../src/config';

export const SECRET = 'segredo-de-teste-com-pelo-menos-32-caracteres';
export const WEB_ORIGIN = 'http://localhost:5173';
export const DEST = 'https://example.com/destino';
/** Prefixo do canal do ao vivo nos testes (LIVE_CHANNEL_PREFIX), único por processo. */
export const LIVE_PREFIX = `test-live-${process.pid}-${Date.now()}:`;

export function setup() {
  const { db, close } = createDb(inject('testDatabaseUrl'), { max: 20 });
  const redis = new Redis(resolveTestRedisUrl());
  const apps: ApiApp[] = [];

  function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
    return {
      ...loadConfig({
        JWT_SECRET: SECRET,
        LOG_LEVEL: 'silent',
        SHORT_DOMAINS: 'encurta.dev,enc.ta',
        SHORT_BASE_URL: 'https://encurta.dev',
        WEB_ORIGIN,
      }),
      // Balde enorme por padrão: só os testes de rate limit usam os valores do ADR.
      bucket: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
      authBucket: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
      // O Pub/Sub do Redis é global (ignora o db): com o prefixo do dev, uma aba aberta em
      // `live:1` entrava no PUBSUB NUMSUB do teste. Um prefixo por processo isola os dois.
      liveChannelPrefix: LIVE_PREFIX,
      ...overrides,
    };
  }

  async function app(overrides: Partial<ApiConfig> = {}, deps: Partial<ApiDeps> = {}) {
    const a = await buildApp({ db, redis, config: config(overrides), ...deps });
    await a.ready();
    apps.push(a);
    return a;
  }

  async function reset() {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    await flushTestRedis(redis);
    await resetTestDb(db);
  }

  async function teardown() {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    redis.disconnect();
    await close();
  }

  return { db: db as Database, redis, config, app, reset, teardown };
}

export interface Session {
  token: string;
  cookie: string;
  userId: number;
  auth: Record<string, string>;
}

export function refreshCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const line = (Array.isArray(raw) ? raw : [raw ?? ''])[0] ?? '';
  return line.split(';')[0]!;
}

let counter = 0;
export async function signup(app: ApiApp, email = `u${++counter}-${Date.now()}@teste.dev`) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'senha-forte-123' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return {
    token: body.access_token as string,
    cookie: refreshCookie(res),
    userId: body.user.id as number,
    auth: { authorization: `Bearer ${body.access_token}` },
    email,
  } satisfies Session & { email: string };
}

export async function createKey(app: ApiApp, s: Session, scopes: string[], name = 'teste') {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: s.auth,
    payload: { name, scopes },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: number; key: string; prefix: string };
}

export async function createLink(app: ApiApp, s: Session, payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/links',
    headers: s.auth,
    payload: { destination: DEST, ...payload },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { ...(res.json() as { id: number; slug: string }), etag: String(res.headers.etag) };
}

/** problem+json conforme o ADR: tipo, campos obrigatórios e status igual ao da resposta. */
export function expectProblem(res: LightMyRequestResponse, status: number, code?: string) {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const p = res.json();
  expect(p).toMatchObject({
    status,
    type: expect.stringMatching(/^https:\/\//),
    title: expect.any(String),
  });
  expect(typeof p.code).toBe('string');
  if (code) expect(p.code).toBe(code);
  if (status === 422 && p.code === 'validation') expect(Array.isArray(p.errors)).toBe(true);
  return p as { code: string; errors?: { field: string; code: string }[]; [k: string]: unknown };
}
