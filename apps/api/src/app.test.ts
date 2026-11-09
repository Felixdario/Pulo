import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('api', () => {
  it('GET /healthz responde 200', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('publica o OpenAPI com /healthz', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().paths).toHaveProperty('/healthz');
    await app.close();
  });
});
