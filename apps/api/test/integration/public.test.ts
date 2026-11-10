import { eq, links } from '@encurtador/db';
import { linkKey } from '@encurtador/db/cache';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEST, expectProblem, setup } from './helpers';

const t = setup();
beforeEach(() => t.reset());
afterAll(() => t.teardown());

describe('POST /v1/public/links', () => {
  it('cria link anônimo, aleatório, que expira em 30 dias', async () => {
    const app = await t.app({ publicBucket: { capacity: 10, refillPerSecond: 10 / 60 } });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/public/links',
      payload: { destination: DEST },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(res.headers.location).toBe(body.short_url);
    expect(res.headers['ratelimit-limit']).toBe('10');
    expect(res.headers['ratelimit-remaining']).toBe('9');
    const days = (Date.parse(body.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    const [row] = await t.db.select().from(links).where(eq(links.slug, body.slug));
    expect(row).toMatchObject({ userId: null, isCustom: false, passwordHash: null, rules: {} });
    expect(await t.redis.get(linkKey(body.slug))).not.toBeNull();
  });

  it('sem alias, regras ou senha; destino validado', async () => {
    const app = await t.app();
    for (const extra of [{ alias: 'meu' }, { password: 'abcd' }, { rules: {} }]) {
      expectProblem(
        await app.inject({
          method: 'POST',
          url: '/v1/public/links',
          payload: { destination: DEST, ...extra },
        }),
        422,
        'validation',
      );
    }
    const p = expectProblem(
      await app.inject({
        method: 'POST',
        url: '/v1/public/links',
        payload: { destination: 'http://169.254.169.254/' },
      }),
      422,
    );
    expect(p.errors![0]).toMatchObject({ field: 'destination', code: 'private_host' });
  });

  it('10 por minuto por visitante; outro visitante tem o próprio balde', async () => {
    const app = await t.app({ publicBucket: { capacity: 10, refillPerSecond: 10 / 60 } });
    const send = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/public/links',
        payload: { destination: DEST },
        remoteAddress: ip,
      });
    for (let i = 0; i < 10; i++) expect((await send('198.51.100.7')).statusCode).toBe(201);
    const blocked = await send('198.51.100.7');
    expectProblem(blocked, 429, 'rate_limited');
    expect(blocked.headers['retry-after']).toBe('6');
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
    expect((await send('198.51.100.8')).statusCode).toBe(201);
    // O balde é por HMAC do IP: nenhuma chave do Redis contém o IP.
    expect(await t.redis.keys('*198.51.100*')).toEqual([]);
  });
});
