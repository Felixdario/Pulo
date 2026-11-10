import SwaggerParser from '@apidevtools/swagger-parser';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem, setup, signup, WEB_ORIGIN } from './helpers';

const t = setup();
beforeEach(() => t.reset());
afterAll(() => t.teardown());

describe('contrato HTTP transversal', () => {
  it('404 de rota em problem+json, com cabeçalhos de rate limit', async () => {
    const app = await t.app();
    for (const url of ['/v1/nada', '/qualquer']) {
      const res = await app.inject({ method: 'GET', url });
      expectProblem(res, 404, 'not_found');
      expect(res.headers['ratelimit-limit']).toBeDefined();
      expect(res.headers['ratelimit-remaining']).toBeDefined();
      expect(res.headers['ratelimit-reset']).toBeDefined();
    }
  });

  it('rate limit por usuário (120, 2/s): a 121ª em rajada → 429 com Retry-After', async () => {
    const app = await t.app({ bucket: { capacity: 120, refillPerSecond: 2 } });
    const s = await signup(app);
    let last;
    const remaining: number[] = [];
    for (let i = 0; i < 121; i++) {
      last = await app.inject({ method: 'GET', url: '/v1/me', headers: s.auth });
      remaining.push(Number(last.headers['ratelimit-remaining']));
    }
    expectProblem(last!, 429, 'rate_limited');
    expect(last!.headers['ratelimit-limit']).toBe('120');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(remaining[0]).toBeGreaterThan(remaining[100]!);
    // Outro usuário (outro balde) continua passando, inclusive vindo do mesmo IP.
    const other = await signup(app);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/me', headers: other.auth })).statusCode,
    ).toBe(200);
  });

  it('CORS só para a origem do web, com credenciais e cabeçalhos expostos', async () => {
    const app = await t.app();
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/v1/links',
      headers: {
        origin: WEB_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,idempotency-key',
      },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(pre.headers['access-control-allow-credentials']).toBe('true');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/links',
      headers: { origin: WEB_ORIGIN },
    });
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(String(res.headers['access-control-expose-headers'])).toContain('ratelimit-remaining');
    const evil = await app.inject({
      method: 'GET',
      url: '/v1/links',
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('415 para Content-Type não suportado e 413 para corpo grande', async () => {
    const app = await t.app();
    const s = await signup(app);
    const text = await app.inject({
      method: 'POST',
      url: '/v1/links',
      headers: { ...s.auth, 'content-type': 'text/plain' },
      payload: 'oi',
    });
    expectProblem(text, 415, 'unsupported_media_type');
    const big = await app.inject({
      method: 'POST',
      url: '/v1/links',
      headers: s.auth,
      payload: { destination: `https://example.com/${'a'.repeat(70_000)}` },
    });
    expectProblem(big, 413, 'payload_too_large');
  });
});

describe('OpenAPI', () => {
  it('/docs abre e o JSON é OpenAPI 3 válido com todas as rotas /v1 e os securitySchemes', async () => {
    const app = await t.app();
    expect((await app.inject({ method: 'GET', url: '/docs' })).statusCode).toBeLessThan(400);
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    await expect(SwaggerParser.validate(structuredClone(spec))).resolves.toBeDefined();
    expect(Object.keys(spec.components.securitySchemes).sort()).toEqual(['apiKey', 'bearerAuth']);

    const routes = app.printRoutes({ commonPrefix: false }).split('\n').filter(Boolean);
    expect(routes.length).toBeGreaterThan(0);
    const expected = [
      ['post', '/v1/auth/signup'],
      ['post', '/v1/auth/login'],
      ['post', '/v1/auth/refresh'],
      ['post', '/v1/auth/logout'],
      ['get', '/v1/me'],
      ['post', '/v1/api-keys'],
      ['get', '/v1/api-keys'],
      ['delete', '/v1/api-keys/{id}'],
      ['post', '/v1/links'],
      ['post', '/v1/links/batch'],
      ['get', '/v1/links'],
      ['get', '/v1/links/{id}'],
      ['patch', '/v1/links/{id}'],
      ['delete', '/v1/links/{id}'],
      ['get', '/v1/links/{id}/stats/timeseries'],
      ['get', '/v1/links/{id}/stats/countries'],
      ['get', '/v1/links/{id}/stats/cities'],
      ['get', '/v1/links/{id}/stats/referrers'],
      ['get', '/v1/links/{id}/stats/browsers'],
      ['get', '/v1/links/{id}/stats/os'],
      ['get', '/v1/links/{id}/stats/devices'],
      ['get', '/v1/links/{id}/stats/summary'],
      ['get', '/v1/overview'],
      ['post', '/v1/live/ticket'],
      ['get', '/v1/live'],
      ['get', '/v1/preview'],
      ['post', '/v1/public/links'],
    ];
    for (const [method, path] of expected) {
      expect(spec.paths[path!]?.[method!], `${method} ${path}`).toBeDefined();
    }
    const v1 = Object.entries(spec.paths as Record<string, Record<string, unknown>>)
      .filter(([p]) => p.startsWith('/v1'))
      .flatMap(([p, ops]) =>
        Object.keys(ops)
          .filter((m) => m !== 'head')
          .map((m) => `${m} ${p}`),
      );
    expect(v1.sort()).toEqual(expected.map(([m, p]) => `${m} ${p}`).sort());
    // Rotas autenticadas declaram os dois esquemas; erros documentados como problem+json.
    expect(spec.paths['/v1/links'].post.security).toEqual([{ bearerAuth: [] }, { apiKey: [] }]);
    expect(spec.paths['/v1/links'].post.responses['422'].content).toHaveProperty(
      'application/problem+json',
    );
    expect(spec.components.schemas).toHaveProperty('Problem');
  });
});
