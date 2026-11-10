import { eq, links, sql } from '@encurtador/db';
import { linkKey, NEGATIVE } from '@encurtador/db/cache';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createKey, createLink, DEST, expectProblem, setup, signup } from './helpers';

const t = setup();
beforeEach(() => t.reset());
afterAll(() => t.teardown());

const count = async () => {
  const [r] = await t.db.select({ n: sql<number>`count(*)::int` }).from(links);
  return r!.n;
};

describe('POST /v1/links', () => {
  it('201 com Location, ETag forte e write-through no cache', async () => {
    const app = await t.app();
    const s = await signup(app);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/links',
      headers: s.auth,
      payload: { destination: 'HTTPS://Example.com/a b', title: 'Promo 🎉', redirect_type: 308 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(res.headers.location).toBe(`/v1/links/${body.id}`);
    expect(res.headers.etag).toMatch(/^"l\d+\.\d+"$/);
    expect(body).toMatchObject({
      destination: 'https://example.com/a%20b',
      title: 'Promo 🎉',
      redirect_type: 308,
      is_custom: false,
      short_url: `https://encurta.dev/${body.slug}`,
      has_password: false,
    });
    expect(body.slug).toMatch(/^[0-9A-Za-z]{7}$/);
    const cached = JSON.parse((await t.redis.get(linkKey(body.slug)))!);
    expect(cached).toMatchObject({ i: body.id, d: 'https://example.com/a%20b', t: 308 });
  });

  it('alias, senha (argon2id), regras e destino de 2.000 caracteres', async () => {
    const app = await t.app();
    const s = await signup(app);
    const long = `https://example.com/${'a'.repeat(2000 - 20)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/links',
      headers: s.auth,
      payload: {
        destination: long,
        alias: 'promo-natal',
        password: 'segredo',
        rules: {
          geo: [{ countries: ['BR', 'PT'], url: 'https://example.com/pt' }],
          device: [{ match: 'ios', url: 'https://apps.apple.com/app/id1' }],
        },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ slug: 'promo-natal', is_custom: true, has_password: true });
    expect(res.json().destination).toHaveLength(2000);
    const [row] = await t.db.select().from(links).where(eq(links.slug, 'promo-natal'));
    expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('422: rede privada, loop, credenciais, esquema, URL de regra e expiração no passado', async () => {
    const app = await t.app();
    const s = await signup(app);
    const cases: [Record<string, unknown>, string, string][] = [
      [{ destination: 'http://127.0.0.1/' }, 'destination', 'private_host'],
      [{ destination: 'http://0x7f.1/' }, 'destination', 'private_host'],
      [{ destination: 'https://sub.encurta.dev/x' }, 'destination', 'loop'],
      [{ destination: 'https://a@b.com/' }, 'destination', 'credentials'],
      [{ destination: 'javascript:alert(1)' }, 'destination', 'unsupported_protocol'],
      [
        { destination: DEST, rules: { geo: [{ countries: ['BR'], url: 'http://10.0.0.1/' }] } },
        'rules.geo.0.url',
        'private_host',
      ],
      [
        { destination: DEST, rules: { device: [{ match: 'ios', url: 'https://enc.ta/a' }] } },
        'rules.device.0.url',
        'loop',
      ],
      [{ destination: DEST, expires_at: '2020-01-01T00:00:00Z' }, 'expires_at', 'past'],
      [{ destination: DEST, alias: 'docs' }, 'alias', 'alias_reserved'],
      [{ destination: DEST, alias: 'a!' }, 'alias', 'alias_format'],
    ];
    for (const [payload, field, code] of cases) {
      const res = await app.inject({ method: 'POST', url: '/v1/links', headers: s.auth, payload });
      const p = expectProblem(res, 422, 'validation');
      expect(p.errors, JSON.stringify(payload)).toContainEqual(
        expect.objectContaining({ field, code }),
      );
    }
    // Campos desconhecidos e tipos errados (Zod).
    const zod = await app.inject({
      method: 'POST',
      url: '/v1/links',
      headers: s.auth,
      payload: { destination: DEST, redirect_type: 303, extra: 1 },
    });
    expect(expectProblem(zod, 422, 'validation').errors!.length).toBeGreaterThanOrEqual(2);
    expect(await count()).toBe(0);
  });

  it('alias em uso → 409 (inclusive de outro usuário e de link apagado)', async () => {
    const app = await t.app();
    const a = await signup(app);
    const b = await signup(app);
    const l = await createLink(app, a, { alias: 'meu-link' });
    const dup = await app.inject({
      method: 'POST',
      url: '/v1/links',
      headers: b.auth,
      payload: { destination: DEST, alias: 'meu-link' },
    });
    expectProblem(dup, 409, 'alias_taken');
    await app.inject({ method: 'DELETE', url: `/v1/links/${l.id}`, headers: a.auth });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/links',
      headers: a.auth,
      payload: { destination: DEST, alias: 'meu-link' },
    });
    expectProblem(again, 409, 'alias_taken');
  });
});

describe('Idempotency-Key', () => {
  it('mesma chave e corpo → mesma resposta com Idempotent-Replayed; outro corpo → 422', async () => {
    const app = await t.app();
    const s = await signup(app);
    const send = (payload: Record<string, unknown>, key = 'chave-1') =>
      app.inject({
        method: 'POST',
        url: '/v1/links',
        headers: { ...s.auth, 'idempotency-key': key },
        payload,
      });
    const first = await send({ destination: DEST, title: 'x' });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const replay = await send({ title: 'x', destination: DEST });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toBe(first.body);
    expect(replay.headers.location).toBe(first.headers.location);
    expectProblem(await send({ destination: DEST, title: 'y' }), 422, 'idempotency_mismatch');
    expect(await count()).toBe(1);
    // A chave é por usuário: B pode usar a mesma.
    const b = await signup(app);
    const other = await app.inject({
      method: 'POST',
      url: '/v1/links',
      headers: { ...b.auth, 'idempotency-key': 'chave-1' },
      payload: { destination: DEST },
    });
    expect(other.statusCode).toBe(201);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
  });

  it('2 POSTs simultâneos com a mesma chave → 1 criação', async () => {
    const app = await t.app();
    const s = await signup(app);
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/links',
        headers: { ...s.auth, 'idempotency-key': 'concorrente' },
        payload: { destination: DEST, password: 'lenta-de-propósito' },
      });
    const results = await Promise.all([send(), send()]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(await count()).toBe(1);
    expect(codes[0]).toBe(201);
    // O segundo vê a reserva em andamento (409) ou, se chegou depois, a resposta gravada.
    expect([201, 409]).toContain(codes[1]);
    if (codes[1] === 409)
      expectProblem(
        results.find((r) => r.statusCode === 409)!,
        409,
        'idempotency_in_progress',
      );
  });

  it('erro de validação não grava: a mesma chave vale depois de corrigir o corpo', async () => {
    const app = await t.app();
    const s = await signup(app);
    const headers = { ...s.auth, 'idempotency-key': 'k2' };
    expectProblem(
      await app.inject({
        method: 'POST',
        url: '/v1/links',
        headers,
        payload: { destination: DEST, alias: 'docs' },
      }),
      422,
    );
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/links',
      headers,
      payload: { destination: DEST, alias: 'docs2' },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('POST /v1/links/batch', () => {
  it('200 com um status por item, na ordem; válidos são criados', async () => {
    const app = await t.app();
    const s = await signup(app);
    await createLink(app, s, { alias: 'ja-existe' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/links/batch',
      headers: s.auth,
      payload: {
        links: [
          { destination: 'https://example.com/1' },
          { destination: 'http://192.168.0.1/' },
          { destination: DEST, alias: 'ja-existe' },
          { destination: DEST, alias: 'novo-alias' },
          { destination: DEST, alias: 'novo-alias' },
          { nada: true },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.map((r: { status: number }) => r.status)).toEqual([
      201, 422, 409, 201, 409, 422,
    ]);
    expect(body.results.map((r: { index: number }) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(body).toMatchObject({ created: 2, failed: 4 });
    expect(body.results[1].error.errors[0]).toMatchObject({
      field: 'destination',
      code: 'private_host',
    });
    expect(await count()).toBe(3);
    expect(await t.redis.get(linkKey('novo-alias'))).not.toBeNull();
  });

  it('1.000 itens passam; 1.001 → 422', async () => {
    const app = await t.app();
    const s = await signup(app);
    const items = Array.from({ length: 1000 }, (_, i) => ({
      destination: `https://example.com/${i}`,
    }));
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/links/batch',
      headers: s.auth,
      payload: { links: items },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().created).toBe(1000);
    const tooMany = await app.inject({
      method: 'POST',
      url: '/v1/links/batch',
      headers: s.auth,
      payload: { links: [...items, { destination: DEST }] },
    });
    expectProblem(tooMany, 422, 'validation');
  });
});

describe('GET /v1/links/:id, PATCH e DELETE', () => {
  it('GET com ETag forte e 304 com If-None-Match', async () => {
    const app = await t.app();
    const s = await signup(app);
    const l = await createLink(app, s);
    const res = await app.inject({ method: 'GET', url: `/v1/links/${l.id}`, headers: s.auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(l.etag);
    const again = await app.inject({
      method: 'GET',
      url: `/v1/links/${l.id}`,
      headers: { ...s.auth, 'if-none-match': l.etag },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers['ratelimit-remaining']).toBeDefined();
  });

  it('PATCH com If-Match certo → 200 e ETag novo; If-Match antigo → 412', async () => {
    const app = await t.app();
    const s = await signup(app);
    const l = await createLink(app, s);
    const ok = await app.inject({
      method: 'PATCH',
      url: `/v1/links/${l.id}`,
      headers: { ...s.auth, 'if-match': l.etag },
      payload: { title: 'novo', destination: 'https://example.org/', password: 'abcd' },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      title: 'novo',
      destination: 'https://example.org/',
      has_password: true,
    });
    expect(ok.headers.etag).not.toBe(l.etag);
    // A outra aba ainda tem o ETag velho.
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/links/${l.id}`,
      headers: { ...s.auth, 'if-match': l.etag },
      payload: { title: 'sobrescreveria' },
    });
    const p = expectProblem(stale, 412, 'precondition_failed');
    expect(p).toBeDefined();
    expect(stale.headers.etag).toBe(ok.headers.etag);
    const cached = JSON.parse((await t.redis.get(linkKey(l.slug)))!);
    expect(cached.d).toBe('https://example.org/');
    expect(cached.p).not.toBeNull();
    // Sem If-Match também funciona (último vence), e remover a senha com null.
    const noMatch = await app.inject({
      method: 'PATCH',
      url: `/v1/links/${l.id}`,
      headers: s.auth,
      payload: { password: null },
    });
    expect(noMatch.json().has_password).toBe(false);
  });

  it('PATCH não muda slug nem alias (422) e valida destino e regras', async () => {
    const app = await t.app();
    const s = await signup(app);
    const l = await createLink(app, s);
    for (const payload of [{ alias: 'outro' }, { slug: 'outro' }]) {
      expectProblem(
        await app.inject({ method: 'PATCH', url: `/v1/links/${l.id}`, headers: s.auth, payload }),
        422,
        'validation',
      );
    }
    const bad = await app.inject({
      method: 'PATCH',
      url: `/v1/links/${l.id}`,
      headers: s.auth,
      payload: { rules: { geo: [{ countries: ['br'], url: DEST }] } },
    });
    expectProblem(bad, 422, 'validation');
  });

  it('desativar grava o cache negativo', async () => {
    const app = await t.app();
    const s = await signup(app);
    const l = await createLink(app, s);
    await app.inject({
      method: 'PATCH',
      url: `/v1/links/${l.id}`,
      headers: s.auth,
      payload: { status: 'disabled' },
    });
    expect(await t.redis.get(linkKey(l.slug))).toBe(NEGATIVE);
  });

  it('DELETE: 204, soft delete, cache negativo; depois GET/PATCH/DELETE do dono → 410', async () => {
    const app = await t.app();
    const s = await signup(app);
    const l = await createLink(app, s);
    const del = await app.inject({ method: 'DELETE', url: `/v1/links/${l.id}`, headers: s.auth });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
    const [row] = await t.db.select().from(links).where(eq(links.id, l.id));
    expect(row!.deletedAt).not.toBeNull();
    expect(await t.redis.get(linkKey(l.slug))).toBe(NEGATIVE);
    expectProblem(
      await app.inject({ method: 'GET', url: `/v1/links/${l.id}`, headers: s.auth }),
      410,
      'gone',
    );
    expectProblem(
      await app.inject({
        method: 'PATCH',
        url: `/v1/links/${l.id}`,
        headers: s.auth,
        payload: { title: 'x' },
      }),
      410,
    );
    expectProblem(
      await app.inject({ method: 'DELETE', url: `/v1/links/${l.id}`, headers: s.auth }),
      410,
    );
    // Some da listagem.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/links', headers: s.auth })).json().data,
    ).toEqual([]);
  });

  it('id inexistente ou malformado', async () => {
    const app = await t.app();
    const s = await signup(app);
    expectProblem(
      await app.inject({ method: 'GET', url: '/v1/links/999999', headers: s.auth }),
      404,
      'not_found',
    );
    expectProblem(
      await app.inject({ method: 'GET', url: '/v1/links/abc', headers: s.auth }),
      422,
      'validation',
    );
  });
});

describe('isolamento entre usuários', () => {
  it('B recebe 404 ao ler, editar, apagar ou ver stats e live dos links de A', async () => {
    const app = await t.app();
    const a = await signup(app);
    const b = await signup(app);
    const l = await createLink(app, a, { title: 'só de A' });
    const kb = await createKey(app, b, ['links:read', 'links:write', 'stats:read']);
    for (const headers of [b.auth, { 'x-api-key': kb.key }]) {
      const calls = [
        { method: 'GET' as const, url: `/v1/links/${l.id}` },
        { method: 'PATCH' as const, url: `/v1/links/${l.id}`, payload: { title: 'de B' } },
        {
          method: 'PATCH' as const,
          url: `/v1/links/${l.id}`,
          payload: { title: 'de B' },
          headers: { 'if-match': l.etag },
        },
        { method: 'DELETE' as const, url: `/v1/links/${l.id}` },
        { method: 'GET' as const, url: `/v1/links/${l.id}/stats/timeseries` },
        { method: 'GET' as const, url: `/v1/links/${l.id}/stats/countries` },
        { method: 'GET' as const, url: `/v1/links/${l.id}/stats/summary` },
      ];
      for (const c of calls) {
        const res = await app.inject({ ...c, headers: { ...headers, ...c.headers } });
        expectProblem(res, 404, 'not_found');
      }
      const list = await app.inject({ method: 'GET', url: '/v1/links', headers });
      expect(list.json().data).toEqual([]);
    }
    // Live: ticket de B com o link de A → 404.
    const ticket = (
      await app.inject({ method: 'POST', url: '/v1/live/ticket', headers: b.auth })
    ).json().ticket;
    expectProblem(
      await app.inject({ method: 'GET', url: `/v1/live?ticket=${ticket}&link_id=${l.id}` }),
      404,
    );
    // Nada mudou no link de A.
    const mine = await app.inject({ method: 'GET', url: `/v1/links/${l.id}`, headers: a.auth });
    expect(mine.json()).toMatchObject({ title: 'só de A' });
    expect(mine.headers.etag).toBe(l.etag);
  });

  it('B recebe 404 (e não 410) para um link apagado de A', async () => {
    const app = await t.app();
    const a = await signup(app);
    const b = await signup(app);
    const l = await createLink(app, a);
    await app.inject({ method: 'DELETE', url: `/v1/links/${l.id}`, headers: a.auth });
    expectProblem(
      await app.inject({ method: 'GET', url: `/v1/links/${l.id}`, headers: b.auth }),
      404,
    );
  });
});

describe('GET /v1/links (lista)', () => {
  it('cursor estável: 45 links de 20 em 20 sem repetir nem pular, com inserção no meio', async () => {
    const app = await t.app();
    const s = await signup(app);
    // Links criados no mesmo milissegundo (lote) testam o desempate por id e a precisão em µs.
    await app.inject({
      method: 'POST',
      url: '/v1/links/batch',
      headers: s.auth,
      payload: {
        links: Array.from({ length: 45 }, (_, i) => ({ destination: `https://example.com/${i}` })),
      },
    });
    const all = (await t.db.select({ id: links.id }).from(links)).map((r) => r.id);
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/links?limit=20${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await app.inject({ method: 'GET', url, headers: s.auth });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      seen.push(...body.data.map((l: { id: number }) => l.id));
      cursor = body.next_cursor;
      pages++;
      // Inserção no meio da paginação: link mais novo vai para o topo e não aparece nas próximas.
      if (pages === 1) await createLink(app, s, { title: 'inserido depois' });
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
    expect([...seen].sort((x, y) => x - y)).toEqual([...all].sort((x, y) => x - y));
  });

  it('ordenações clicks e title, com cursor', async () => {
    const app = await t.app();
    const s = await signup(app);
    for (const [title, clicks] of [
      ['b', 5],
      ['a', 9],
      ['c', 5],
      [null, 0],
    ] as const) {
      const l = await createLink(app, s, { title });
      await t.db.update(links).set({ clickCount: clicks }).where(eq(links.id, l.id));
    }
    const page = async (q: string) => {
      const out: (string | null)[] = [];
      let cursor: string | null = null;
      do {
        const url: string = `/v1/links?${q}&limit=1${cursor ? `&cursor=${cursor}` : ''}`;
        const res: LightMyRequestResponse = await app.inject({
          method: 'GET',
          url,
          headers: s.auth,
        });
        out.push(...res.json().data.map((l: { title: string | null }) => l.title));
        cursor = res.json().next_cursor;
      } while (cursor);
      return out;
    };
    expect(await page('sort=title')).toEqual([null, 'a', 'b', 'c']);
    expect(await page('sort=title&order=desc')).toEqual(['c', 'b', 'a', null]);
    const byClicks = await page('sort=clicks');
    expect(byClicks[0]).toBe('a');
    expect(byClicks.slice(1, 3).sort()).toEqual(['b', 'c']);
    expect(byClicks[3]).toBeNull();
  });

  it('filtros q, status, has_password e datas; cursor de outro filtro → 422', async () => {
    const app = await t.app();
    const s = await signup(app);
    await createLink(app, s, { title: 'Campanha Verão', password: 'abcd' });
    await createLink(app, s, {
      title: 'Outro',
      destination: 'https://loja.example.com/verao_100%',
    });
    const off = await createLink(app, s, { title: 'Desligado' });
    await app.inject({
      method: 'PATCH',
      url: `/v1/links/${off.id}`,
      headers: s.auth,
      payload: { status: 'disabled' },
    });
    const exp = await createLink(app, s, { title: 'Expirado' });
    await t.db
      .update(links)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(links.id, exp.id));

    const titles = async (q: string) =>
      (await app.inject({ method: 'GET', url: `/v1/links?${q}`, headers: s.auth }))
        .json()
        .data.map((l: { title: string }) => l.title)
        .sort();
    expect(await titles('q=ver')).toEqual(['Campanha Verão', 'Outro']);
    expect(await titles('q=100%25')).toEqual(['Outro']);
    expect(await titles('q=_')).toEqual(['Outro']);
    expect(await titles('status=disabled')).toEqual(['Desligado']);
    expect(await titles('status=expired')).toEqual(['Expirado']);
    expect(await titles('status=active')).toEqual(['Campanha Verão', 'Outro']);
    expect(await titles('has_password=true')).toEqual(['Campanha Verão']);
    const today = new Date().toISOString().slice(0, 10);
    expect(await titles(`created_from=${today}&created_to=${today}`)).toHaveLength(4);
    expect(await titles('created_to=2020-01-01')).toEqual([]);

    const first = await app.inject({ method: 'GET', url: '/v1/links?limit=1', headers: s.auth });
    const cursor = first.json().next_cursor;
    expectProblem(
      await app.inject({
        method: 'GET',
        url: `/v1/links?limit=1&status=active&cursor=${cursor}`,
        headers: s.auth,
      }),
      422,
      'cursor_mismatch',
    );
    expectProblem(
      await app.inject({ method: 'GET', url: '/v1/links?cursor=lixo', headers: s.auth }),
      422,
      'invalid_cursor',
    );
    expectProblem(
      await app.inject({ method: 'GET', url: '/v1/links?limit=101', headers: s.auth }),
      422,
      'validation',
    );
  });

  it('ETag fraco e 304; muda quando os cliques mudam', async () => {
    const app = await t.app();
    const s = await signup(app);
    const l = await createLink(app, s);
    const res = await app.inject({ method: 'GET', url: '/v1/links', headers: s.auth });
    const etag = String(res.headers.etag);
    expect(etag).toMatch(/^W\/"/);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/links',
          headers: { ...s.auth, 'if-none-match': etag },
        })
      ).statusCode,
    ).toBe(304);
    await t.db.update(links).set({ clickCount: 3 }).where(eq(links.id, l.id));
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/links',
          headers: { ...s.auth, 'if-none-match': etag },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('links:read sem links:write', () => {
  it('lê mas não edita nem apaga', async () => {
    const app = await t.app();
    const s = await signup(app);
    const l = await createLink(app, s);
    const k = await createKey(app, s, ['links:read']);
    const h = { 'x-api-key': k.key };
    expect(
      (await app.inject({ method: 'GET', url: `/v1/links/${l.id}`, headers: h })).statusCode,
    ).toBe(200);
    expectProblem(
      await app.inject({
        method: 'PATCH',
        url: `/v1/links/${l.id}`,
        headers: h,
        payload: { title: 'x' },
      }),
      403,
      'insufficient_scope',
    );
    expectProblem(
      await app.inject({ method: 'DELETE', url: `/v1/links/${l.id}`, headers: h }),
      403,
      'insufficient_scope',
    );
    expectProblem(
      await app.inject({ method: 'GET', url: `/v1/links/${l.id}/stats/summary`, headers: h }),
      403,
      'insufficient_scope',
    );
  });
});
