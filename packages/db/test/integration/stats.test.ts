import { appendFileSync } from 'node:fs';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountSeriesQuery,
  accountTopLinksQuery,
  dailySeriesQuery,
  hourlySeriesQuery,
  linkSummary,
  previewAppsQuery,
  summaryQuery,
  timeseries,
  topDimension,
  topDimensionQuery,
} from '../../src/index';
import { resetTestDb, testDb } from './helpers';

const { db, close } = testDb();

const AGGREGATES = ['clicks_hourly', 'clicks_daily', 'clicks_daily_dim', 'clicks_daily_preview'];
let userId = 0;
let linkId = 0;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function walk(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) walk(child, out);
  return out;
}

async function plan(query: SQL): Promise<{ nodes: PlanNode[]; text: string }> {
  const [row] = (await db.execute(sql`EXPLAIN (FORMAT JSON) ${query}`)) as unknown as {
    'QUERY PLAN': { Plan: PlanNode }[];
  }[];
  const textRows = (await db.execute(sql`EXPLAIN ${query}`)) as unknown as {
    'QUERY PLAN': string;
  }[];
  return {
    nodes: walk(row!['QUERY PLAN'][0]!.Plan),
    text: textRows.map((r) => r['QUERY PLAN']).join('\n'),
  };
}

/** Nenhuma leitura da tabela bruta; agregados só por índice da PK. */
async function expectIndexOnly(query: SQL, expected: string[]) {
  const { nodes, text } = await plan(query);
  // PLANS_FILE=<caminho> grava os planos (é de onde vem o resumo no comentário de src/stats.ts).
  if (process.env.PLANS_FILE) appendFileSync(process.env.PLANS_FILE, `${text}\n\n`);
  const scans = nodes.filter((n) => n['Relation Name'] !== undefined);
  for (const s of scans) {
    expect(s['Relation Name'], text).not.toMatch(/^clicks($|_default|_p\d)/);
    if (AGGREGATES.includes(s['Relation Name']!)) {
      expect(s['Node Type'], text).not.toBe('Seq Scan');
    }
  }
  const indexes = nodes.map((n) => n['Index Name']).filter(Boolean);
  for (const idx of expected) expect(indexes, text).toContain(idx);
}

beforeAll(async () => {
  await resetTestDb(db);
  // 50 usuários × 20 links × 120 dias no clicks_daily (120 mil linhas); horas, dimensões e prévias
  // para os 3 primeiros usuários. ANALYZE para o planejador ver tabelas do tamanho real: uma conta
  // é uma fração pequena dos agregados, como em produção, e não uma tabela minúscula inteira.
  await db.execute(sql`
    INSERT INTO users (email, password_hash)
    SELECT 'u' || i || '@stats.test', 'x' FROM generate_series(1, 50) i`);
  await db.execute(sql`
    INSERT INTO links (user_id, slug, destination)
    SELECT u.id, 'st' || u.id || '_' || i, 'https://example.com/' || i
    FROM users u, generate_series(1, 20) i`);
  await db.execute(sql`
    INSERT INTO clicks_hourly (link_id, hour, total, humans, bots, previews)
    SELECT l.id, h, 4, 2, 1, 1
    FROM links l,
         generate_series(date_trunc('day', now()) - interval '120 days',
                         date_trunc('day', now()) - interval '1 hour', interval '1 hour') h
    WHERE l.user_id <= 3`);
  await db.execute(sql`
    INSERT INTO clicks_daily (link_id, day, total, humans, uniques, bots, previews)
    SELECT l.id, (date_trunc('day', now()) - interval '120 days')::date + i, 96, 48, 24, 24, 24
    FROM links l, generate_series(0, 119) i`);
  await db.execute(sql`
    INSERT INTO clicks_daily_dim (link_id, dim, day, value, n)
    SELECT d.link_id, dim, d.day, v, CASE v WHEN 'a' THEN 24 WHEN 'b' THEN 12 ELSE 6 END
    FROM clicks_daily d JOIN links l ON l.id = d.link_id AND l.user_id <= 3,
         unnest(ARRAY['country', 'city', 'referrer', 'browser', 'os', 'device']) dim,
         unnest(ARRAY['a', 'b', 'c', 'd']) v`);
  await db.execute(sql`
    INSERT INTO clicks_daily_preview (link_id, day, app, n)
    SELECT d.link_id, d.day, app, 12
    FROM clicks_daily d JOIN links l ON l.id = d.link_id AND l.user_id <= 3,
         unnest(ARRAY['whatsapp', 'slack']) app`);
  await db.execute(sql`ANALYZE`);
  const [row] = (await db.execute(
    sql`SELECT l.id, l.user_id FROM links l ORDER BY l.id LIMIT 1`,
  )) as unknown as { id: string; user_id: string }[];
  linkId = Number(row!.id);
  userId = Number(row!.user_id);
}, 120_000);

afterAll(async () => {
  await resetTestDb(db);
  await close();
});

const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const day = (d: Date) => d.toISOString().slice(0, 10);

describe('EXPLAIN das consultas de estatísticas', () => {
  it('série por hora e por dia fora de UTC usam a PK do clicks_hourly', async () => {
    for (const granularity of ['hour', 'day', 'month'] as const) {
      await expectIndexOnly(
        hourlySeriesQuery({
          linkId,
          granularity,
          from: daysAgo(granularity === 'hour' ? 7 : 60),
          to: now,
          tz: 'America/Sao_Paulo',
        }),
        ['clicks_hourly_pkey'],
      );
    }
  });

  it('série diária e mensal em UTC usam a PK do clicks_daily', async () => {
    for (const granularity of ['day', 'month'] as const) {
      await expectIndexOnly(
        dailySeriesQuery({ linkId, granularity, from: daysAgo(90), to: now, tz: 'UTC' }),
        ['clicks_daily_pkey'],
      );
    }
  });

  it('top N de dimensão, resumo e prévias usam as PKs', async () => {
    const range = { linkId, fromDay: day(daysAgo(30)), toDay: day(now) };
    await expectIndexOnly(topDimensionQuery({ ...range, dim: 'country', limit: 10 }), [
      'clicks_daily_dim_pkey',
    ]);
    await expectIndexOnly(summaryQuery(range), ['clicks_daily_pkey']);
    await expectIndexOnly(previewAppsQuery(range), ['clicks_daily_preview_pkey']);
  });

  it('visão geral da conta: links do usuário × PK do clicks_daily', async () => {
    const range = { userId, fromDay: day(daysAgo(30)), toDay: day(now) };
    await expectIndexOnly(accountSeriesQuery(range), ['clicks_daily_pkey']);
    await expectIndexOnly(accountTopLinksQuery({ ...range, limit: 5 }), ['clicks_daily_pkey']);
  });
});

describe('resultados', () => {
  it('série diária UTC soma igual ao clicks_hourly e traz únicos', async () => {
    const from = new Date(`${day(daysAgo(10))}T00:00:00Z`);
    const to = new Date(`${day(daysAgo(3))}T00:00:00Z`);
    const r = await timeseries(db, { linkId, granularity: 'day', from, to, tz: 'UTC' });
    expect(r.source).toBe('daily');
    expect(r.points).toHaveLength(7);
    for (const p of r.points) expect(p).toMatchObject({ humans: 48, uniques: 24, total: 96 });
  });

  it('em America/Sao_Paulo o dia local vai de 03:00 a 03:00 UTC', async () => {
    // O primeiro dia semeado (há 120 dias, 00:00 UTC) cai às 21:00 do dia anterior em São Paulo.
    const firstUtc = new Date(`${day(daysAgo(120))}T00:00:00Z`);
    const r = await timeseries(db, {
      linkId,
      granularity: 'day',
      from: new Date(firstUtc.getTime() - 86_400_000),
      to: new Date(firstUtc.getTime() + 86_400_000),
      tz: 'America/Sao_Paulo',
    });
    expect(r.source).toBe('hourly');
    // `from` (00:00 UTC de D-1) é 21:00 local de D-2: três dias locais, D-2, D-1 e D.
    // D-2 não tem dado; D-1 local só tem as 3 primeiras horas UTC de D (21h–24h locais).
    expect(r.points.map((p) => p.humans)).toEqual([0, 6, 48]);
    expect(r.points[1]!.label).toBe(day(new Date(firstUtc.getTime() - 86_400_000)));
    expect(r.points.every((p) => p.uniques === null)).toBe(true);
  });

  it('top N com "outros" e resumo', async () => {
    const range = { linkId, fromDay: day(daysAgo(10)), toDay: day(daysAgo(0)) };
    const top = await topDimension(db, { ...range, dim: 'browser', limit: 2 });
    expect(top.items).toEqual([
      { value: 'a', n: 240 },
      { value: 'b', n: 120 },
    ]);
    expect(top.others).toBe(120);
    expect(top.total).toBe(480);
    const s = await linkSummary(db, range);
    expect(s).toMatchObject({ total: 960, humans: 480, uniques: 240, bots: 240, previews: 240 });
    expect(s.previewApps).toEqual([
      { app: 'slack', n: 120 },
      { app: 'whatsapp', n: 120 },
    ]);
  });
});
