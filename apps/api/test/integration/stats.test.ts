import { sql } from '@encurtador/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createKey, createLink, expectProblem, setup, signup } from './helpers';

const t = setup();
beforeEach(() => t.reset());
afterAll(() => t.teardown());

const DAY = '2026-10-15';

/**
 * Agregados coerentes para um link: no dia UTC `DAY`, 1 humano por hora (24), 1 robô às 01:00 e
 * 1 prévia às 02:00; no dia seguinte, 10 humanos às 01:00 UTC (22:00 do dia `DAY` em São Paulo).
 */
async function seed(linkId: number) {
  await t.db.execute(sql`
    INSERT INTO clicks_hourly (link_id, hour, total, humans, bots, previews)
    SELECT ${linkId}, h, 1 + (h = ${`${DAY}T01:00:00Z`}::timestamptz)::int + (h = ${`${DAY}T02:00:00Z`}::timestamptz)::int,
           1, (h = ${`${DAY}T01:00:00Z`}::timestamptz)::int, (h = ${`${DAY}T02:00:00Z`}::timestamptz)::int
    FROM generate_series(${`${DAY}T00:00:00Z`}::timestamptz, ${`${DAY}T23:00:00Z`}::timestamptz, interval '1 hour') h`);
  await t.db.execute(sql`
    INSERT INTO clicks_hourly (link_id, hour, total, humans, bots, previews)
    VALUES (${linkId}, '2026-10-16T01:00:00Z', 10, 10, 0, 0)`);
  await t.db.execute(sql`
    INSERT INTO clicks_daily (link_id, day, total, humans, uniques, bots, previews) VALUES
      (${linkId}, ${DAY}, 26, 24, 7, 1, 1),
      (${linkId}, '2026-10-16', 10, 10, 4, 0, 0)`);
  await t.db.execute(sql`
    INSERT INTO clicks_daily_dim (link_id, dim, day, value, n) VALUES
      (${linkId}, 'country', ${DAY}, 'BR', 14), (${linkId}, 'country', ${DAY}, 'PT', 6),
      (${linkId}, 'country', ${DAY}, 'US', 3), (${linkId}, 'country', ${DAY}, '(desconhecido)', 1),
      (${linkId}, 'country', '2026-10-16', 'BR', 10),
      (${linkId}, 'city', ${DAY}, 'BR/São Paulo', 24),
      (${linkId}, 'referrer', ${DAY}, 'news.ycombinator.com', 20), (${linkId}, 'referrer', ${DAY}, '(direto)', 4),
      (${linkId}, 'browser', ${DAY}, 'Chrome', 24), (${linkId}, 'os', ${DAY}, 'Android', 24),
      (${linkId}, 'device', ${DAY}, 'mobile', 24)`);
  await t.db.execute(sql`
    INSERT INTO clicks_daily_preview (link_id, day, app, n) VALUES (${linkId}, ${DAY}, 'whatsapp', 1)`);
}

async function fixture() {
  const app = await t.app();
  const s = await signup(app);
  const l = await createLink(app, s, { title: 'com cliques' });
  await seed(l.id);
  const get = (path: string, headers: Record<string, string> = s.auth) =>
    app.inject({ method: 'GET', url: `/v1/links/${l.id}/stats/${path}`, headers });
  return { app, s, l, get };
}

describe('GET /v1/links/:id/stats/timeseries', () => {
  it('dia em UTC: lê o clicks_daily, com únicos', async () => {
    const { get } = await fixture();
    const res = await get(`timeseries?granularity=day&from=${DAY}&to=2026-10-16`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ source: 'daily', uniques_available: true, tz: 'UTC' });
    expect(body.uniques_note).toMatch(/UTC/);
    expect(body.points).toEqual([
      {
        start: `${DAY}T00:00:00Z`,
        label: DAY,
        total: 26,
        humans: 24,
        uniques: 7,
        bots: 1,
        previews: 1,
      },
      {
        start: '2026-10-16T00:00:00Z',
        label: '2026-10-16',
        total: 10,
        humans: 10,
        uniques: 4,
        bots: 0,
        previews: 0,
      },
    ]);
    expect(body.totals).toEqual({ total: 36, humans: 34, uniques: 11, bots: 1, previews: 1 });
  });

  it('tz=America/Sao_Paulo: soma as horas no dia local e o total do dia muda certo', async () => {
    const { get } = await fixture();
    const res = await get(`timeseries?granularity=day&from=${DAY}&to=${DAY}&tz=America/Sao_Paulo`);
    const body = res.json();
    expect(body).toMatchObject({ source: 'hourly', uniques_available: false });
    expect(body.from).toBe(`${DAY}T03:00:00.000Z`);
    // Dia local 15/10 = [15/10 03:00Z, 16/10 03:00Z): 21 humanos do dia UTC 15 + 10 das 01:00Z do 16.
    expect(body.points).toHaveLength(1);
    expect(body.points[0]).toMatchObject({
      label: DAY,
      humans: 31,
      bots: 0,
      previews: 0,
      uniques: null,
    });
    // Em UTC o mesmo dia tem 24.
    const utc = (await get(`timeseries?granularity=day&from=${DAY}&to=${DAY}`)).json();
    expect(utc.points[0].humans).toBe(24);
  });

  it('hora e mês; limites de 14 dias e 5 anos; fuso inválido', async () => {
    const { get } = await fixture();
    const hour = (
      await get(`timeseries?granularity=hour&from=${DAY}T00:00:00Z&to=${DAY}T03:00:00Z`)
    ).json();
    expect(hour.points.map((p: { total: number }) => p.total)).toEqual([1, 2, 2]);
    const month = (await get('timeseries?granularity=month&from=2026-09-01&to=2026-11-30')).json();
    expect(month.points.map((p: { label: string; humans: number }) => [p.label, p.humans])).toEqual(
      [
        ['2026-09', 0],
        ['2026-10', 34],
        ['2026-11', 0],
      ],
    );
    expect(month.uniques_available).toBe(false);
    expectProblem(
      await get('timeseries?granularity=hour&from=2026-10-01&to=2026-10-20'),
      422,
      'range_too_large',
    );
    expectProblem(
      await get('timeseries?granularity=month&from=2020-01-01&to=2026-10-20'),
      422,
      'range_too_large',
    );
    expectProblem(await get('timeseries?tz=Marte/Olympus'), 422, 'validation');
    expectProblem(await get('timeseries?granularity=week'), 422, 'validation');
    expectProblem(await get(`timeseries?from=2026-10-20&to=2026-10-01`), 422, 'validation');
  });

  it('ETag fraco e 304', async () => {
    const { get, s } = await fixture();
    const first = await get(`timeseries?from=${DAY}&to=${DAY}`);
    const again = await get(`timeseries?from=${DAY}&to=${DAY}`, {
      ...s.auth,
      'if-none-match': String(first.headers.etag),
    });
    expect(again.statusCode).toBe(304);
  });
});

describe('dimensões e resumo', () => {
  it('top N mais "outros" por dimensão', async () => {
    const { get } = await fixture();
    const c = (await get(`countries?from=${DAY}&to=${DAY}&limit=2`)).json();
    expect(c).toMatchObject({ dimension: 'country', total: 24, others: 4, from: DAY, to: DAY });
    expect(c.items).toEqual([
      { value: 'BR', n: 14, share: 0.5833 },
      { value: 'PT', n: 6, share: 0.25 },
    ]);
    const two = (await get(`countries?from=${DAY}&to=2026-10-16`)).json();
    expect(two.items[0]).toMatchObject({ value: 'BR', n: 24 });
    for (const [path, value] of [
      ['cities', 'BR/São Paulo'],
      ['referrers', 'news.ycombinator.com'],
      ['browsers', 'Chrome'],
      ['os', 'Android'],
      ['devices', 'mobile'],
    ]) {
      const r = (await get(`${path}?from=${DAY}&to=${DAY}`)).json();
      expect(r.items[0].value, path).toBe(value);
    }
    const empty = (await get('countries?from=2026-01-01&to=2026-01-31')).json();
    expect(empty).toMatchObject({ total: 0, items: [], others: 0 });
    expectProblem(await get('countries?limit=0'), 422, 'validation');
  });

  it('resumo: totais, únicos × humanos, robôs e prévias', async () => {
    const { get } = await fixture();
    const s = (await get(`summary?from=${DAY}&to=2026-10-16`)).json();
    expect(s).toMatchObject({
      total: 36,
      humans: 34,
      uniques: 11,
      unique_ratio: 0.3235,
      bots: 1,
      previews: 1,
      preview_apps: [{ app: 'whatsapp', n: 1 }],
    });
  });

  it('chave com stats:read lê; link apagado → 410', async () => {
    const { app, s, l, get } = await fixture();
    const k = await createKey(app, s, ['stats:read']);
    expect((await get('summary', { 'x-api-key': k.key })).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `/v1/links/${l.id}`, headers: s.auth });
    expectProblem(await get('summary'), 410, 'gone');
  });
});

describe('GET /v1/overview', () => {
  it('total de links, cliques no período, top links e série diária da conta', async () => {
    const { app, s, l } = await fixture();
    const other = await createLink(app, s, { title: 'sem cliques' });
    await createLink(app, s, { title: 'terceiro' });
    const b = await signup(app);
    const lb = await createLink(app, b);
    await seed(lb.id);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/overview?from=${DAY}&to=2026-10-17`,
      headers: s.auth,
    });
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json();
    expect(o.links_total).toBe(3);
    expect(o.clicks).toEqual({ total: 36, humans: 34, bots: 1, previews: 1 });
    expect(o.top_links).toEqual([
      {
        id: l.id,
        slug: l.slug,
        short_url: `https://encurta.dev/${l.slug}`,
        title: 'com cliques',
        total: 36,
        humans: 34,
      },
    ]);
    expect(o.top_links.map((x: { id: number }) => x.id)).not.toContain(other.id);
    expect(o.series.map((d: { day: string; humans: number }) => [d.day, d.humans])).toEqual([
      [DAY, 24],
      ['2026-10-16', 10],
      ['2026-10-17', 0],
    ]);
  });
});
