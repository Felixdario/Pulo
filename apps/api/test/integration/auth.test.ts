import { refreshTokens } from '@encurtador/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem, refreshCookie, setup, signup } from './helpers';

const t = setup();
beforeEach(() => t.reset());
afterAll(() => t.teardown());

const XRW = { 'x-requested-with': 'encurtador' };

describe('POST /v1/auth/signup e /login', () => {
  it('cadastra, devolve access token, cookie httpOnly e Location', async () => {
    const app = await t.app();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'Ana@Teste.dev', password: 'senha-forte-123' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers.location).toBe('/v1/me');
    expect(res.json()).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      user: { email: 'ana@teste.dev' },
    });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(
      /^refresh=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/,
    );
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });

  it('e-mail repetido (sem diferenciar maiúsculas) → 409', async () => {
    const app = await t.app();
    await signup(app, 'bia@teste.dev');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'BIA@teste.dev', password: 'outra-senha-1' },
    });
    expectProblem(res, 409, 'email_taken');
  });

  it('validação → 422 com errors[]; JSON malformado → 400', async () => {
    const app = await t.app();
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'nao-e-email', password: '123' },
    });
    const p = expectProblem(bad, 422, 'validation');
    expect(p.errors!.map((e) => e.field).sort()).toEqual(['email', 'password']);
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": ',
    });
    expectProblem(malformed, 400, 'bad_request');
  });

  it('login: senha errada e e-mail inexistente dão a mesma resposta', async () => {
    const app = await t.app();
    const s = await signup(app, 'caio@teste.dev');
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'caio@teste.dev', password: 'errada-123' },
    });
    const ghost = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ninguem@teste.dev', password: 'errada-123' },
    });
    expectProblem(wrong, 401, 'invalid_credentials');
    expect(ghost.body).toBe(wrong.body);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'CAIO@teste.dev', password: 'senha-forte-123' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.id).toBe(s.userId);
  });

  it('login: 10/min por e-mail → 429 com Retry-After', async () => {
    const app = await t.app({ authBucket: { capacity: 10, refillPerSecond: 10 / 60 } });
    await signup(app, 'dani@teste.dev');
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 11; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'dani@teste.dev', password: 'errada-123' },
        remoteAddress: `203.0.113.${i + 1}`,
      });
      codes.push(last.statusCode);
    }
    expect(codes.slice(0, 9).every((c) => c === 401)).toBe(true);
    expectProblem(last!, 429, 'rate_limited');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('GET /v1/me', () => {
  it('com o access token; sem ou com token adulterado → 401', async () => {
    const app = await t.app();
    const s = await signup(app);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: s.auth });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: s.userId, auth: { kind: 'session' } });
    expect(me.json().auth.scopes).toEqual(['links:read', 'links:write', 'stats:read']);

    const none = await app.inject({ method: 'GET', url: '/v1/me' });
    expectProblem(none, 401, 'unauthorized');
    expect(none.headers['www-authenticate']).toMatch(/^Bearer/);
    const tampered = s.token.slice(0, -3) + (s.token.endsWith('aaa') ? 'bbb' : 'aaa');
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expectProblem(bad, 401, 'unauthorized');
  });
});

describe('POST /v1/auth/refresh e /logout', () => {
  it('exige X-Requested-With (CSRF) → 403', async () => {
    const app = await t.app();
    const s = await signup(app);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: s.cookie },
    });
    expectProblem(res, 403, 'csrf');
  });

  it('rotaciona: o cookie novo funciona e o antigo não', async () => {
    const app = await t.app();
    const s = await signup(app);
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { ...XRW, cookie: s.cookie },
    });
    expect(r1.statusCode).toBe(200);
    const c2 = refreshCookie(r1);
    expect(c2).not.toBe(s.cookie);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${r1.json().access_token}` },
    });
    expect(me.statusCode).toBe(200);
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { ...XRW, cookie: c2 },
    });
    expect(r2.statusCode).toBe(200);
  });

  it('reuso de um refresh já rotacionado revoga a família inteira', async () => {
    const app = await t.app();
    const s = await signup(app);
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { ...XRW, cookie: s.cookie },
    });
    const legit = refreshCookie(r1);
    // O atacante reapresenta o refresh antigo (copiado): 401 e família revogada.
    const reuse = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { ...XRW, cookie: s.cookie },
    });
    expectProblem(reuse, 401, 'invalid_refresh');
    expect(String(reuse.headers['set-cookie'])).toContain('Max-Age=0');
    // O dono legítimo também perde a sessão: precisa logar de novo.
    const after = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { ...XRW, cookie: legit },
    });
    expectProblem(after, 401, 'invalid_refresh');
    const rows = await t.db.select().from(refreshTokens);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
  });

  it('outro login é outra família e não é afetado pelo reuso', async () => {
    const app = await t.app();
    const s = await signup(app, 'eva@teste.dev');
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'eva@teste.dev', password: 'senha-forte-123' },
    });
    const other = refreshCookie(login);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { ...XRW, cookie: s.cookie },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { ...XRW, cookie: s.cookie },
    });
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { ...XRW, cookie: other },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('logout revoga e limpa o cookie; refresh depois → 401', async () => {
    const app = await t.app();
    const s = await signup(app);
    const out = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { ...XRW, cookie: s.cookie },
    });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/^refresh=; .*Max-Age=0/);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { ...XRW, cookie: s.cookie },
    });
    expectProblem(r, 401, 'invalid_refresh');
  });

  it('em produção o cookie é __Host-refresh com Secure', async () => {
    const app = await t.app({ secureCookies: true });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'fe@teste.dev', password: 'senha-forte-123' },
    });
    expect(String(res.headers['set-cookie'])).toMatch(
      /^__Host-refresh=.*; Path=\/; HttpOnly; SameSite=Strict; .*Secure$/,
    );
  });
});
