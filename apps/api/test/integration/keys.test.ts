import { apiKeys, eq } from '@encurtador/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createKey, createLink, expectProblem, setup, signup } from './helpers';

const t = setup();
beforeEach(() => t.reset());
afterAll(() => t.teardown());

describe('/v1/api-keys', () => {
  it('cria: a chave inteira aparece uma vez; a listagem só mostra o prefixo', async () => {
    const app = await t.app();
    const s = await signup(app);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: s.auth,
      payload: { name: 'CI', scopes: ['links:read', 'links:read'] },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.key).toMatch(/^enc_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$/);
    expect(created.headers.location).toBe(`/v1/api-keys/${body.id}`);
    expect(body.scopes).toEqual(['links:read']);

    const list = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: s.auth });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(body.key.slice(13));
    expect(list.json().data).toEqual([
      expect.objectContaining({ id: body.id, display: `enc_${body.prefix}_…`, last_used_at: null }),
    ]);
    // No banco, só o SHA-256.
    const [row] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, body.id));
    expect(row!.keyHash).not.toContain(body.key);
    expect(row!.keyHash).toHaveLength(43);
  });

  it('autentica por Bearer enc_… e por X-API-Key; grava last_used_at', async () => {
    const app = await t.app();
    const s = await signup(app);
    const k = await createKey(app, s, ['links:read']);
    const a = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${k.key}` },
    });
    expect(a.json()).toMatchObject({ id: s.userId, auth: { kind: 'key', scopes: ['links:read'] } });
    const b = await app.inject({
      method: 'GET',
      url: '/v1/links',
      headers: { 'x-api-key': k.key },
    });
    expect(b.statusCode).toBe(200);
    await expect
      .poll(
        async () => (await t.db.select().from(apiKeys).where(eq(apiKeys.id, k.id)))[0]!.lastUsedAt,
      )
      .not.toBeNull();
  });

  it('chave errada, malformada ou de prefixo inexistente → 401', async () => {
    const app = await t.app();
    const s = await signup(app);
    const k = await createKey(app, s, ['links:read']);
    const wrongSecret = `${k.key.slice(0, 13)}${'x'.repeat(32)}`;
    for (const key of [wrongSecret, 'enc_curta', `enc_ZZZZZZZZ_${'a'.repeat(32)}`]) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/links',
        headers: { 'x-api-key': key },
      });
      expectProblem(res, 401, 'unauthorized');
    }
  });

  it('escopo: sem links:write → 403 insufficient_scope', async () => {
    const app = await t.app();
    const s = await signup(app);
    const k = await createKey(app, s, ['links:read']);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/links',
      headers: { 'x-api-key': k.key },
      payload: { destination: 'https://example.com/' },
    });
    const p = expectProblem(res, 403, 'insufficient_scope');
    expect(p.required_scope).toBe('links:write');
    const stats = await app.inject({
      method: 'GET',
      url: '/v1/overview',
      headers: { 'x-api-key': k.key },
    });
    expectProblem(stats, 403, 'insufficient_scope');
  });

  it('uma chave não gerencia chaves (403 session_required)', async () => {
    const app = await t.app();
    const s = await signup(app);
    const k = await createKey(app, s, ['links:read', 'links:write', 'stats:read']);
    for (const [method, url] of [
      ['GET', '/v1/api-keys'],
      ['POST', '/v1/api-keys'],
      ['DELETE', `/v1/api-keys/${k.id}`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { 'x-api-key': k.key },
        ...(method === 'POST' ? { payload: { name: 'x', scopes: ['links:read'] } } : {}),
      });
      expectProblem(res, 403, 'session_required');
    }
  });

  it('revogada para de funcionar na hora; revogar de novo → 404', async () => {
    const app = await t.app();
    const s = await signup(app);
    const k = await createKey(app, s, ['links:read']);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/links', headers: { 'x-api-key': k.key } }))
        .statusCode,
    ).toBe(200);
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${k.id}`,
      headers: s.auth,
    });
    expect(del.statusCode).toBe(204);
    expectProblem(
      await app.inject({ method: 'GET', url: '/v1/links', headers: { 'x-api-key': k.key } }),
      401,
    );
    expectProblem(
      await app.inject({ method: 'DELETE', url: `/v1/api-keys/${k.id}`, headers: s.auth }),
      404,
    );
    expect(
      (await app.inject({ method: 'GET', url: '/v1/api-keys', headers: s.auth })).json().data,
    ).toEqual([]);
  });

  it('escopos inválidos → 422', async () => {
    const app = await t.app();
    const s = await signup(app);
    for (const scopes of [[], ['admin']]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: s.auth,
        payload: { name: 'x', scopes },
      });
      expectProblem(res, 422, 'validation');
    }
  });
});

describe('isolamento de chaves', () => {
  it('B não vê nem revoga as chaves de A; a chave de A só enxerga os links de A', async () => {
    const app = await t.app();
    const a = await signup(app);
    const b = await signup(app);
    const ka = await createKey(app, a, ['links:read']);
    await createLink(app, b, { title: 'de B' });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/api-keys', headers: b.auth })).json().data,
    ).toEqual([]);
    expectProblem(
      await app.inject({ method: 'DELETE', url: `/v1/api-keys/${ka.id}`, headers: b.auth }),
      404,
      'not_found',
    );
    const list = await app.inject({
      method: 'GET',
      url: '/v1/links',
      headers: { 'x-api-key': ka.key },
    });
    expect(list.json().data).toEqual([]);
    // A chave continua válida depois da tentativa de B.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/me', headers: { 'x-api-key': ka.key } }))
        .statusCode,
    ).toBe(200);
  });
});
