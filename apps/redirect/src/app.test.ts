import { SHARED_VERSION } from '@encurtador/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('redirect', () => {
  it('GET /healthz responde 200', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', shared: SHARED_VERSION });
    await app.close();
  });
});
