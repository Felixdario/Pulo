import { createLink, getClickCount } from '@encurtador/db';
import { createMemoryGeoLookup } from '@encurtador/geo';
import { buildApp } from '@encurtador/redirect/app';
import { loadConfig } from '@encurtador/redirect/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setup, UA } from './helpers';

const t = setup();
const { db, sql } = t;
const IP = '203.0.113.77';
const FORGED = '198.51.100.9';
const geo = createMemoryGeoLookup({
  '203.0.113.0': { country: 'BR', city: 'São Paulo', region: 'São Paulo' },
  '198.51.100.0': { country: 'US', city: 'Nova York', region: 'Nova York' },
});

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.teardown();
});

function redirectApp(stream: string) {
  return buildApp({
    db,
    redis: t.redis,
    config: {
      ...loadConfig({
        JWT_SECRET: 'segredo-de-teste-com-pelo-menos-32-caracteres',
        LOG_LEVEL: 'warn',
      }),
      clicksStream: stream,
    },
    loadClickTotal: (id) => getClickCount(db, id),
  });
}

describe('fim a fim: redirect real + worker real', () => {
  it('GET /:slug com UA de iPhone e XFF forjado → linha no agregado, país pelo IP real, nenhum IP gravado', async () => {
    const link = await createLink(db, { destination: 'https://example.com/', alias: 'ponta' });
    const stream = t.newStream();
    const app = redirectApp(stream);
    const w = t.worker(stream, {}, { geo });
    await w.start();

    const res = await app.inject({
      method: 'GET',
      url: '/ponta?utm_source=x',
      headers: {
        'user-agent': UA.iphone,
        'x-forwarded-for': FORGED,
        referer: 'https://www.instagram.com/p/segredo?igsh=abc',
      },
      remoteAddress: IP,
    });
    expect(res.statusCode).toBe(302);
    await new Promise((r) => setTimeout(r, 100));
    await t.drained(stream);

    const dims = await sql<{ dim: string; value: string; n: string }[]>`
      SELECT dim, value, n FROM clicks_daily_dim WHERE link_id = ${link.id} ORDER BY dim`;
    expect(Object.fromEntries(dims.map((d) => [d.dim, d.value]))).toEqual({
      browser: 'Mobile Safari',
      city: 'BR/São Paulo', // do IP real (203.0.113.x), não do XFF forjado (EUA)
      country: 'BR',
      device: 'mobile',
      os: 'iOS',
      referrer: 'instagram.com',
    });
    const [daily] =
      await sql`SELECT total::int, humans::int, uniques::int FROM clicks_daily WHERE link_id = ${link.id}`;
    expect(daily).toEqual({ total: 1, humans: 1, uniques: 1 });
    expect(await getClickCount(db, link.id)).toBe(1);

    // Nenhum IP (nem o real nem o forjado) em linha nenhuma de tabela nenhuma.
    const tables = await sql<{ t: string }[]>`
      SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    expect(tables.length).toBeGreaterThan(8);
    for (const { t: table } of tables) {
      const [hit] = await sql.unsafe(
        `SELECT count(*)::int AS n FROM "${table}" x WHERE row_to_json(x)::text LIKE $1 OR row_to_json(x)::text LIKE $2`,
        [`%${IP}%`, `%${FORGED}%`],
      );
      expect(hit!.n, table).toBe(0);
    }
    // Nem no stream, nem nos logs do worker.
    const entries = await t.redis.xrange(stream, '-', '+');
    expect(JSON.stringify(entries)).not.toContain(IP);
    expect(t.logs.join('')).not.toContain(IP);
    await app.close();
  });

  it('limite de cliques do redirect inicializa a partir de links.click_count', async () => {
    const link = await createLink(db, {
      destination: 'https://example.com/',
      alias: 'contado',
      maxClicks: 3,
    });
    const stream = t.newStream();
    const w = t.worker(stream, {}, { geo });
    await w.start();
    // Dois cliques processados pelo worker antes de o redirect conhecer o link.
    const first = redirectApp(stream);
    for (let i = 0; i < 2; i++) {
      const r = await first.inject({
        method: 'GET',
        url: '/contado',
        headers: { 'user-agent': UA.chrome },
        remoteAddress: IP,
      });
      expect(r.statusCode).toBe(302);
    }
    await first.close();
    await new Promise((r) => setTimeout(r, 100));
    await t.drained(stream);
    expect(await getClickCount(db, link.id)).toBe(2);
    await t.redis.del(`cap:${link.id}`); // ex.: o Redis perdeu o contador

    const again = redirectApp(stream);
    const ok = await again.inject({
      method: 'GET',
      url: '/contado',
      headers: { 'user-agent': UA.chrome },
      remoteAddress: IP,
    });
    expect(ok.statusCode).toBe(302);
    const over = await again.inject({
      method: 'GET',
      url: '/contado',
      headers: { 'user-agent': UA.chrome },
      remoteAddress: IP,
    });
    expect(over.statusCode).toBe(410);
    await again.close();
  });
});
