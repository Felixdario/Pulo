import { createDb } from '@encurtador/db';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { decodeEntities, parseMeta } from './modules/preview/parse';
import { zonedMidnight } from './lib/time';

// Sem banco nem Redis: conexões preguiçosas e rate limit desligado; só rotas que não tocam neles.
const { db, close } = createDb('postgres://x:x@127.0.0.1:1/x');
const redis = new Redis({ lazyConnect: true, enableOfflineQueue: false });
const config = {
  ...loadConfig({
    JWT_SECRET: 'segredo-de-teste-com-pelo-menos-32-caracteres',
    LOG_LEVEL: 'silent',
  }),
  rateLimit: false,
};

afterAll(async () => {
  redis.disconnect();
  await close();
});

// Timeout maior: o boot do Fastify fica lento quando o pnpm -r roda os testes pesados em paralelo.
describe('api', () => {
  it('GET /healthz responde 200', async () => {
    const app = await buildApp({ db, redis, config });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  }, 30_000);

  it('publica o OpenAPI com /healthz e /v1', async () => {
    const app = await buildApp({ db, redis, config });
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().paths).toHaveProperty('/healthz');
    expect(res.json().paths).toHaveProperty('/v1/links');
    await app.close();
  }, 30_000);

  it('rota inexistente e sem login dão problem+json', async () => {
    const app = await buildApp({ db, redis, config });
    const notFound = await app.inject({ method: 'GET', url: '/nada' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.headers['content-type']).toContain('application/problem+json');
    const noAuth = await app.inject({ method: 'GET', url: '/v1/links' });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json()).toMatchObject({ status: 401, code: 'unauthorized' });
    await app.close();
  }, 30_000);
});

describe('helpers', () => {
  it('meia-noite local com e sem horário de verão', () => {
    expect(zonedMidnight('2026-11-09', 'America/Sao_Paulo').toISOString()).toBe(
      '2026-11-09T03:00:00.000Z',
    );
    expect(zonedMidnight('2026-07-01', 'Europe/Lisbon').toISOString()).toBe(
      '2026-06-30T23:00:00.000Z',
    );
    expect(zonedMidnight('2026-01-01', 'UTC').toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('extrai og:title, descrição, imagem e favicon', () => {
    const html = `<html><head><title>Fallback</title>
      <meta content="Título &amp; mais" property="og:title">
      <meta name="description" content="Desc">
      <meta property="og:image" content="/img.png">
      <link rel="shortcut icon" href="/f.ico"></head></html>`;
    expect(parseMeta(html, 'https://ex.com/a/b')).toEqual({
      title: 'Título & mais',
      description: 'Desc',
      image: 'https://ex.com/img.png',
      favicon: 'https://ex.com/f.ico',
      siteName: null,
    });
    expect(decodeEntities('&#x1F600; &#39;a&#39;')).toBe("😀 'a'");
  });
});
