import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

// Timeout maior: o boot do Fastify fica lento quando o pnpm -r roda os testes pesados em paralelo.
describe('api', () => {
  it('GET /healthz responde 200', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  }, 30_000);

  it('publica o OpenAPI com /healthz', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().paths).toHaveProperty('/healthz');
    await app.close();
  }, 30_000);
});
