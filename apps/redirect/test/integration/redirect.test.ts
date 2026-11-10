import { createLink, eq, links } from '@encurtador/db';
import { linkKey, NEGATIVE, writeThrough } from '@encurtador/db/cache';
import { hash } from '@node-rs/argon2';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setup, spyRedis, UA } from './helpers';

const t = setup();
const { db, redis } = t;
const dest = 'https://example.com/destino';

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.teardown();
});

const get = (
  a: ReturnType<typeof t.app>,
  url: string,
  headers: Record<string, string> = {},
  remoteAddress = '198.51.100.10',
) =>
  a.inject({ method: 'GET', url, headers: { 'user-agent': UA.chrome, ...headers }, remoteAddress });

describe('ordem das regras (ADR 0002, seção 2)', () => {
  it('1. reservado ou formato inválido → 404 sem tocar no Redis nem no banco', async () => {
    const spy = spyRedis(redis);
    const a = t.app({}, { redis: spy.redis });
    await a.ready();
    spy.calls.length = 0;
    t.queries.length = 0;
    for (const url of [
      '/docs',
      '/API',
      '/Admin',
      '/favicon.ico',
      '/robots.txt',
      '/-abc',
      '/_abc',
      `/${'a'.repeat(65)}`,
      '/ab%20c',
      '/a.b',
      '/%E2%82%AC',
    ]) {
      const res = await get(a, url);
      expect(res.statusCode, url).toBe(404);
    }
    expect(spy.calls).toEqual([]);
    expect(t.linkSelects()).toBe(0);
  });

  it('2. token bucket: 60 em rajada passam, a 61ª → 429 com Retry-After e RateLimit-*', async () => {
    await createLink(db, { destination: dest, alias: 'rajada' });
    const now = 1_800_000_000_000;
    const a = t.app({ bucket: { capacity: 60, refillPerSecond: 10 }, bucketNow: () => now });
    for (let i = 0; i < 60; i++) {
      const res = await get(a, '/rajada');
      expect(res.statusCode).toBe(302);
      expect(res.headers['ratelimit-remaining']).toBe(String(59 - i));
    }
    const res = await get(a, '/rajada');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.headers['ratelimit-limit']).toBe('60');
    expect(res.headers['ratelimit-remaining']).toBe('0');
    expect(res.headers['ratelimit-reset']).toBe('6');
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // Outro visitante tem o próprio balde.
    expect((await get(a, '/rajada', {}, '198.51.100.11')).statusCode).toBe(302);
    const json = await get(a, '/rajada', { accept: 'application/json' });
    expect(json.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(json.json()).toMatchObject({ status: 429 });
  });

  it('3. inexistente → 404 amigável (HTML ou problem+json) e cache negativo ∅ por 30 s', async () => {
    const a = t.app();
    const html = await get(a, '/naoexiste');
    expect(html.statusCode).toBe(404);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.body).toContain('<style>');
    expect(html.body).toContain('Link não encontrado');
    const json = await get(a, '/naoexiste', { accept: 'application/json' });
    expect(json.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(json.json()).toMatchObject({ status: 404, title: 'Link não encontrado' });
    expect(await redis.get(linkKey('naoexiste'))).toBe(NEGATIVE);
    expect(await redis.ttl(linkKey('naoexiste'))).toBeLessThanOrEqual(30);
  });

  it('4. desativado, apagado ou bloqueado → mesma resposta que inexistente', async () => {
    const a = t.app();
    const missing = await get(a, '/fantasma');
    for (const [alias, patch] of [
      ['desativado', { status: 'disabled' as const }],
      ['apagado', { deletedAt: new Date() }],
      ['bloqueado', { status: 'blocked_loop' as const }],
    ] as const) {
      const link = await createLink(db, { destination: dest, alias });
      await db.update(links).set(patch).where(eq(links.id, link.id));
      const res = await get(a, `/${alias}`);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(missing.body);
      expect(res.headers['content-type']).toBe(missing.headers['content-type']);
    }
  });

  it('5. expires_at ≤ agora → 410 "este link expirou"; futuro → 302', async () => {
    await createLink(db, {
      destination: dest,
      alias: 'velho',
      expiresAt: new Date(Date.now() - 1000),
    });
    await createLink(db, {
      destination: dest,
      alias: 'novo',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const a = t.app();
    const res = await get(a, '/velho');
    expect(res.statusCode).toBe(410);
    expect(res.body).toContain('Este link expirou');
    // A página diz até quando o link valia (fase 7).
    expect(res.body).toContain('Quem criou este link definiu que ele valia até');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await get(a, '/velho', { accept: 'application/json' })).json()).toMatchObject({
      status: 410,
      type: 'about:blank#expired',
    });
    expect((await get(a, '/novo')).statusCode).toBe(302);
  });

  it('6. senha: formulário 200 no-store → POST errado 401 → POST certo 303 + cookie → GET 302', async () => {
    await createLink(db, {
      destination: dest,
      alias: 'secreto',
      passwordHash: await hash('abre-te-sesamo'),
    });
    const a = t.app();
    const form = await get(a, '/secreto?utm_source=x');
    expect(form.statusCode).toBe(200);
    expect(form.headers['cache-control']).toBe('no-store');
    expect(form.body).toContain('action="/secreto?utm_source=x"');
    expect(form.body).toContain('type="password"');

    const post = (password: string, ip = '198.51.100.20') =>
      a.inject({
        method: 'POST',
        url: '/secreto?utm_source=x',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA.chrome },
        payload: `password=${encodeURIComponent(password)}`,
        remoteAddress: ip,
      });

    const wrong = await post('errada');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain('Senha incorreta');
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const right = await post('abre-te-sesamo');
    expect(right.statusCode).toBe(303);
    expect(right.headers.location).toBe('/secreto?utm_source=x');
    const cookie = String(right.headers['set-cookie']);
    expect(cookie).toMatch(/^__unlock_secreto=\d+\.[\w-]+; /);
    expect(cookie).toContain('Max-Age=3600');
    expect(cookie).toContain('Path=/secreto');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure'); // dev; em produção leva Secure
    const pair = cookie.split(';')[0]!;

    const ok = await get(a, '/secreto?utm_source=x', { cookie: pair });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe(`${dest}?utm_source=x`);

    // Cookie adulterado ou de outro link não vale.
    expect((await get(a, '/secreto', { cookie: `${pair}x` })).statusCode).toBe(200);
    await createLink(db, { destination: dest, alias: 'outro', passwordHash: await hash('y') });
    expect(
      (await get(a, '/outro', { cookie: pair.replace('__unlock_secreto', '__unlock_outro') }))
        .statusCode,
    ).toBe(200);

    // Trocar a senha invalida os cookies antigos (via write-through da API).
    const [row] = await db
      .update(links)
      .set({ passwordHash: await hash('nova') })
      .where(eq(links.slug, 'secreto'))
      .returning();
    await writeThrough(redis, 'secreto', row!);
    expect((await get(a, '/secreto', { cookie: pair })).statusCode).toBe(200);
  });

  it('6b. senha: bucket próprio de 5/min → a 6ª tentativa é 429', async () => {
    await createLink(db, { destination: dest, alias: 'cofre', passwordHash: await hash('x') });
    const a = t.app({ bucketNow: () => 1_800_000_000_000 });
    const post = () =>
      a.inject({
        method: 'POST',
        url: '/cofre',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'password=errada',
        remoteAddress: '198.51.100.30',
      });
    for (let i = 0; i < 5; i++) expect((await post()).statusCode).toBe(401);
    const sixth = await post();
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBe('12');
    expect(sixth.headers['ratelimit-limit']).toBe('5');
  });

  it('7. limite de cliques: humanos consomem, prévias e robôs não; depois → 410', async () => {
    await createLink(db, { destination: dest, alias: 'unico', maxClicks: 2 });
    const a = t.app();
    // Prévia do WhatsApp, Googlebot e HEAD sem UA antes: não gastam o limite.
    expect((await get(a, '/unico', { 'user-agent': UA.whatsapp })).statusCode).toBe(302);
    expect((await get(a, '/unico', { 'user-agent': UA.googlebot })).statusCode).toBe(302);
    const head = await a.inject({ method: 'HEAD', url: '/unico', remoteAddress: '198.51.100.40' });
    expect(head.statusCode).toBe(302);

    expect((await get(a, '/unico')).statusCode).toBe(302);
    expect((await get(a, '/unico', { 'user-agent': UA.iphone })).statusCode).toBe(302);
    const third = await get(a, '/unico');
    expect(third.statusCode).toBe(410);
    expect(third.body).toContain('atingiu o limite');
    expect(third.body).toContain('Ele foi criado para 2 cliques, e todos já foram usados.');
    // Esgotado vale para robôs também (mas eles não incrementam).
    expect((await get(a, '/unico', { 'user-agent': UA.whatsapp })).statusCode).toBe(410);
    expect(await redis.get('cap:1')).toBe('3');
  });

  it('7b. limite inicializa a partir do total do banco (SET NX)', async () => {
    const link = await createLink(db, { destination: dest, alias: 'quase', maxClicks: 5 });
    const a = t.app({}, { loadClickTotal: async (id) => (id === link.id ? 4 : 0) });
    expect((await get(a, '/quase')).statusCode).toBe(302);
    expect((await get(a, '/quase')).statusCode).toBe(410);
  });

  it('8. destino: país (proxy confiável) → dispositivo → padrão', async () => {
    await createLink(db, {
      destination: dest,
      alias: 'regras',
      rules: {
        geo: [{ countries: ['BR', 'PT'], url: 'https://example.com/pt' }],
        device: [
          { match: 'ios', url: 'https://apps.apple.com/app' },
          { match: 'android', url: 'https://play.google.com/app' },
        ],
      },
    });
    const loc = async (a: ReturnType<typeof t.app>, headers: Record<string, string>, ip?: string) =>
      (await get(a, '/regras', headers, ip)).headers.location;

    // Sem proxy confiável, X-Country e CF-IPCountry são ignorados.
    const plain = t.app();
    expect(await loc(plain, { 'x-country': 'BR' })).toBe(dest);
    expect(await loc(plain, { 'cf-ipcountry': 'BR', 'user-agent': UA.iphone })).toBe(
      'https://apps.apple.com/app',
    );

    // TRUST_PROXY com o IP do par: o cabeçalho vale.
    const proxied = t.app({ trustProxy: ['10.0.0.0/8'] });
    expect(await loc(proxied, { 'cf-ipcountry': 'br' }, '10.1.2.3')).toBe('https://example.com/pt');
    expect(await loc(proxied, { 'x-country': 'PT', 'user-agent': UA.iphone }, '10.1.2.3')).toBe(
      'https://example.com/pt',
    );
    expect(await loc(proxied, { 'x-country': 'US', 'user-agent': UA.android }, '10.1.2.3')).toBe(
      'https://play.google.com/app',
    );
    expect(await loc(proxied, { 'x-country': 'BR' }, '198.51.100.9')).toBe(dest);

    // Sem cabeçalho, a CountryLookup (mmdb na fase 3) responde.
    const looked = t.app({}, { countryLookup: { lookup: () => 'BR' } });
    expect(await loc(looked, {})).toBe('https://example.com/pt');
  });

  it('9. query string e UTMs: anexadas, mas as do destino vencem; forward_query=false não repassa', async () => {
    await createLink(db, {
      destination: 'https://example.com/p?utm_source=dono&x=1#sec',
      alias: 'utm',
    });
    await createLink(db, {
      destination: 'https://example.com/p',
      alias: 'semquery',
      forwardQuery: false,
    });
    const a = t.app();
    const res = await get(a, '/utm?utm_source=spam&utm_medium=social&a=1&a=2');
    expect(res.headers.location).toBe(
      'https://example.com/p?utm_source=dono&x=1&utm_medium=social&a=1&a=2#sec',
    );
    expect((await get(a, '/semquery?utm_source=spam')).headers.location).toBe(
      'https://example.com/p',
    );
    expect((await get(a, '/utm')).headers.location).toBe(
      'https://example.com/p?utm_source=dono&x=1#sec',
    );
  });

  it('10. responde 30x e só depois publica o evento', async () => {
    const link = await createLink(db, { destination: dest, alias: 'evento' });
    const a = t.app();
    const res = await get(a, '/evento', { referer: 'https://news.example/post' }, '203.0.113.77');
    expect(res.statusCode).toBe(302);
    const [ev] = await t.events(1);
    expect(ev).toMatchObject({
      link_id: String(link.id),
      ip_net: '203.0.113.0',
      ua: UA.chrome,
      ref: 'https://news.example/post',
      country: '',
      kind_hint: 'human',
    });
    expect(ev!.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(ev!.visitor).toMatch(/^[\w-]{22}$/);
    expect(Math.abs(Number(ev!.ts) - Date.now())).toBeLessThan(5000);
  });

  it('bypass de destino: esquema proibido gravado direto no banco nunca vira Location', async () => {
    // createLink não valida o destino (é papel da API); simula um destino ruim que escapou.
    await createLink(db, { destination: 'JaVaScRiPt:alert(1)', alias: 'js-cru' });
    await createLink(db, {
      destination: dest,
      alias: 'regra-js',
      rules: { device: [{ match: 'ios', url: 'data:text/html,<script>alert(1)</script>' }] },
    });
    const a = t.app();
    expect((await get(a, '/js-cru')).statusCode).toBe(404);
    const ios = await get(a, '/regra-js', { 'user-agent': UA.iphone });
    expect(ios.statusCode).toBe(404);
    expect(ios.headers.location).toBeUndefined();
    expect((await get(a, '/regra-js')).headers.location).toBe(dest);
    expect(await t.events(1, 'clicks', 300)).toHaveLength(1);
  });
});

describe('status e Cache-Control (ADR 0002, seção 1)', () => {
  it.each([
    [301, 'public, max-age=600'],
    [302, 'private, max-age=0'],
    [307, 'private, max-age=0'],
    [308, 'public, max-age=600'],
  ] as const)('%d → %s', async (redirectType, cc) => {
    await createLink(db, {
      destination: dest,
      alias: `tipo-${redirectType}`,
      redirectType,
      cacheTtl: 600,
    });
    const res = await get(t.app(), `/tipo-${redirectType}`);
    expect(res.statusCode).toBe(redirectType);
    expect(res.headers['cache-control']).toBe(cc);
    expect(res.headers.location).toBe(dest);
  });

  it('302 é o padrão e usa cache_ttl 3600 nos permanentes', async () => {
    await createLink(db, { destination: dest, alias: 'padrao' });
    await createLink(db, { destination: dest, alias: 'perm', redirectType: 301 });
    const a = t.app();
    expect((await get(a, '/padrao')).statusCode).toBe(302);
    expect((await get(a, '/perm')).headers['cache-control']).toBe('public, max-age=3600');
  });
});

describe('cache', () => {
  it('invalidação: write-through da API → o próximo GET já usa o destino novo', async () => {
    const link = await createLink(db, { destination: 'https://old.example/', alias: 'editavel' });
    const a = t.app();
    expect((await get(a, '/editavel')).headers.location).toBe('https://old.example/');
    const [row] = await db
      .update(links)
      .set({ destination: 'https://new.example/' })
      .where(eq(links.id, link.id))
      .returning();
    // Sem write-through o cache ainda serve o antigo…
    expect((await get(a, '/editavel')).headers.location).toBe('https://old.example/');
    await writeThrough(redis, 'editavel', row!);
    expect((await get(a, '/editavel')).headers.location).toBe('https://new.example/');
    // Apagar: write-through com ∅ → 404 na hora.
    await writeThrough(redis, 'editavel', null);
    expect((await get(a, '/editavel')).statusCode).toBe(404);
  });

  it('corrida SET NX × SET: leitura atrasada não regrava o valor velho', async () => {
    const link = await createLink(db, { destination: 'https://old.example/', alias: 'corrida' });
    // A leitura busca a linha antiga e trava antes do SET NX; nesse meio-tempo a API edita.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = spyRedis(redis, {
      set: async (...args: unknown[]) => {
        if (args.includes('NX')) await gate;
        return (redis.set as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    });
    const a = t.app({}, { redis: spy.redis });
    const pending = get(a, '/corrida');
    await new Promise((r) => setTimeout(r, 100));
    const [row] = await db
      .update(links)
      .set({ destination: 'https://new.example/' })
      .where(eq(links.id, link.id))
      .returning();
    await writeThrough(redis, 'corrida', row!);
    release();
    expect((await pending).headers.location).toBe('https://old.example/'); // a leitura em curso
    expect((await get(a, '/corrida')).headers.location).toBe('https://new.example/');
    expect(await redis.get(linkKey('corrida'))).toContain('new.example');
  });

  it('cache negativo: 100 GETs de slug inexistente → 1 consulta ao banco', async () => {
    const a = t.app();
    await a.ready();
    t.queries.length = 0;
    for (let i = 0; i < 100; i++) expect((await get(a, '/ninguem')).statusCode).toBe(404);
    expect(t.linkSelects()).toBe(1);
  });

  it('stampede: 200 GETs concorrentes num slug frio → 1 consulta ao banco', async () => {
    await createLink(db, { destination: dest, alias: 'frio' });
    const a = t.app();
    await a.ready();
    t.queries.length = 0;
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => get(a, '/frio', {}, `198.51.100.${i % 250}`)),
    );
    expect(results.every((r) => r.statusCode === 302)).toBe(true);
    expect(t.linkSelects()).toBe(1);
  });

  it('o mesmo vale para o slug inexistente concorrente (single-flight do negativo)', async () => {
    const a = t.app();
    await a.ready();
    t.queries.length = 0;
    const results = await Promise.all(Array.from({ length: 200 }, () => get(a, '/vazio')));
    expect(results.every((r) => r.statusCode === 404)).toBe(true);
    expect(t.linkSelects()).toBe(1);
  });

  it('cache quente: 0 consultas ao banco; CACHE=off: 1 consulta por GET e nada no Redis', async () => {
    await createLink(db, { destination: dest, alias: 'quente' });
    const a = t.app();
    await get(a, '/quente');
    t.queries.length = 0;
    for (let i = 0; i < 20; i++) await get(a, '/quente');
    expect(t.linkSelects()).toBe(0);

    await redis.del(linkKey('quente'));
    const off = t.app({ cache: false });
    t.queries.length = 0;
    for (let i = 0; i < 5; i++) expect((await get(off, '/quente')).statusCode).toBe(302);
    expect(t.linkSelects()).toBe(5);
    expect(await redis.exists(linkKey('quente'))).toBe(0);
  });

  it('1 ida ao Redis (Lua bucket+GET) × 2 idas (bucket + GET): mesmo resultado', async () => {
    await createLink(db, { destination: dest, alias: 'idas' });
    for (const redisRoundTrips of [1, 2] as const) {
      const spy = spyRedis(redis);
      const a = t.app({ redisRoundTrips }, { redis: spy.redis });
      await get(a, '/idas'); // aquece
      spy.calls.length = 0;
      const res = await get(a, '/idas');
      expect(res.statusCode).toBe(302);
      const hot = spy.calls.filter((c) => ['evalsha', 'eval', 'get'].includes(c));
      expect(hot).toEqual(redisRoundTrips === 1 ? ['evalsha'] : ['evalsha', 'get']);
    }
  });
});

describe('eventos e privacidade', () => {
  const IP = '203.0.113.77';

  it('o evento não leva o IP bruto em campo nenhum; nem os logs', async () => {
    await createLink(db, { destination: dest, alias: 'privado' });
    const a = t.app();
    await get(a, '/privado', { 'x-forwarded-for': '192.0.2.200' }, IP);
    await get(a, '/inexistente-x', {}, IP);
    const [ev] = await t.events(1);
    for (const [k, v] of Object.entries(ev!)) {
      expect(v, k).not.toContain(IP);
      expect(v, k).not.toContain('192.0.2.200');
    }
    expect(ev!.ip_net).toBe('203.0.113.0');
    const logs = t.logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(IP);
    expect(logs).not.toContain('192.0.2.200');
    // Também nenhuma chave do Redis contém o IP.
    const keys = await redis.keys('*');
    expect(keys.join(' ')).not.toContain(IP);
  });

  it('X-Forwarded-For ignorado sem TRUST_PROXY/DEV_TRUST_XFF; aceito com DEV_TRUST_XFF=1', async () => {
    await createLink(db, { destination: dest, alias: 'xff' });
    await get(t.app(), '/xff', { 'x-forwarded-for': '192.0.2.200' }, IP);
    await get(t.app({ devTrustXff: true }), '/xff', { 'x-forwarded-for': '192.0.2.200' }, IP);
    const evs = await t.events(2);
    expect(evs.map((e) => e.ip_net)).toEqual(['203.0.113.0', '192.0.2.0']);
  });

  it('XFF também não muda o balde: forjar o cabeçalho não fura o rate limit', async () => {
    await createLink(db, { destination: dest, alias: 'forja' });
    const now = 1_800_000_000_000;
    const a = t.app({ bucket: { capacity: 3, refillPerSecond: 0.001 }, bucketNow: () => now });
    const codes = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await get(a, '/forja', { 'x-forwarded-for': `192.0.2.${i}` }, IP)).statusCode);
    }
    expect(codes).toEqual([302, 302, 302, 429, 429]);
  });

  it('visitor: mesmo IP+UA no mesmo dia → mesmo hash; UA diferente → outro', async () => {
    await createLink(db, { destination: dest, alias: 'unicos' });
    const a = t.app();
    await get(a, '/unicos', {}, IP);
    await get(a, '/unicos', {}, IP);
    await get(a, '/unicos', { 'user-agent': UA.iphone }, IP);
    const evs = await t.events(3);
    expect(evs[0]!.visitor).toBe(evs[1]!.visitor);
    expect(evs[2]!.visitor).not.toBe(evs[0]!.visitor);
    expect(new Set(evs.map((e) => e.event_id)).size).toBe(3);
    expect(await redis.exists(`salt:${new Date().toISOString().slice(0, 10)}`)).toBe(1);
  });

  it('a resposta não espera o XADD: XADD de 2 s não aumenta a latência', async () => {
    await createLink(db, { destination: dest, alias: 'lento' });
    let xadds = 0;
    const spy = spyRedis(redis, {
      xadd: (...args: unknown[]) =>
        new Promise((r) => setTimeout(r, 2000)).then(() => {
          xadds++;
          return (redis.xadd as (...a: unknown[]) => Promise<unknown>)(...args);
        }),
    });
    const a = t.app({}, { redis: spy.redis });
    await get(a, '/lento'); // aquece cache e sal
    const start = performance.now();
    const res = await get(a, '/lento');
    const elapsed = performance.now() - start;
    expect(res.statusCode).toBe(302);
    expect(elapsed).toBeLessThan(500);
    expect(xadds).toBe(0); // os XADD ainda estão "no ar"
    await new Promise((r) => setTimeout(r, 2200));
    expect(xadds).toBe(2);
  });
});

describe('Redis fora do ar', () => {
  it('fallback para o Postgres sem rate limit, com métrica; cliques vão para o buffer', async () => {
    await createLink(db, { destination: dest, alias: 'resiste' });
    const dead = new Redis({
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    dead.on('error', () => {});
    const a = t.app({ bucket: { capacity: 1, refillPerSecond: 0.001 } }, { redis: dead });
    for (let i = 0; i < 3; i++) {
      const res = await get(a, '/resiste');
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(dest);
    }
    expect((await get(a, '/naoha')).statusCode).toBe(404);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.clicks.buffered).toBe(3);
    const metrics = (await a.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toMatch(/redis_fallback_total \d+/);
    expect(metrics).toMatch(/clicks_publish_failed_total 1/);
    expect(t.logs.join('\n')).toContain('ALERTA: Redis indisponível');
    dead.disconnect();
  });

  it('buffer cheio: excedente descartado com clicks_dropped_total', async () => {
    await createLink(db, { destination: dest, alias: 'transborda' });
    const dead = new Redis({
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    dead.on('error', () => {});
    const a = t.app({ clicksBufferLimit: 2 }, { redis: dead });
    for (let i = 0; i < 5; i++) await get(a, '/transborda');
    await new Promise((r) => setTimeout(r, 50));
    expect(a.clicks.buffered).toBe(2);
    expect((await a.inject({ method: 'GET', url: '/metrics' })).body).toMatch(
      /clicks_dropped_total 3/,
    );
    dead.disconnect();
  });

  it('o buffer é reenviado quando o Redis volta', async () => {
    await createLink(db, { destination: dest, alias: 'volta' });
    let fail = true;
    const spy = spyRedis(redis, {
      xadd: (...args: unknown[]) =>
        fail
          ? Promise.reject(new Error('fora'))
          : (redis.xadd as (...a: unknown[]) => Promise<unknown>)(...args),
    });
    const a = t.app({}, { redis: spy.redis });
    await get(a, '/volta');
    await get(a, '/volta');
    await new Promise((r) => setTimeout(r, 50));
    expect(a.clicks.buffered).toBe(2);
    fail = false;
    await a.clicks.flush();
    expect(a.clicks.buffered).toBe(0);
    expect(await t.events(2)).toHaveLength(2);
  });
});

describe('/metrics', () => {
  it('expõe o histograma por status e cache e os contadores', async () => {
    await createLink(db, { destination: dest, alias: 'medido' });
    const a = t.app();
    await get(a, '/medido');
    await get(a, '/medido');
    await get(a, '/nao-ha');
    const body = (await a.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toMatch(/redirect_duration_seconds_bucket\{.*status="302".*cache="miss"/);
    expect(body).toMatch(/redirect_duration_seconds_count\{status="302",cache="hit"\} 1/);
    expect(body).toMatch(
      /cache_requests_total\{result="negative"\}|cache_requests_total\{result="miss"\} 2/,
    );
    for (const name of [
      'rate_limited_total',
      'clicks_publish_failed_total',
      'clicks_dropped_total',
      'cache_requests_total',
    ]) {
      expect(body).toContain(name);
    }
  });
});
