import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { benchSql, readMeta, type BenchMeta } from '../../src/bench-db';
import { allChecks, daily, dayScope, everything, linkScope, totals } from './checks';

/**
 * Consistência agregado × bruta no `encurtador_bench` (depois do `seed:big`): os agregados que o
 * dashboard lê batem **exatamente** com COUNT / COUNT DISTINCT na tabela bruta.
 */
let sql: Sql;
let meta: BenchMeta;
let sample: { hot: number[]; cold: number[]; zero: number[] };

beforeAll(async () => {
  sql = await benchSql({ max: 2, params: { work_mem: '256MB', application_name: 'consistency' } });
  meta = await readMeta(sql);
  const hot = await sql<{ id: string }[]>`
    SELECT id FROM links ORDER BY click_count DESC, id LIMIT 3`;
  // Frios: o do seed e mais alguns com poucos cliques (1 a 20 humanos).
  const cold = await sql<{ id: string }[]>`
    SELECT id FROM links WHERE click_count BETWEEN 1 AND 20 ORDER BY id LIMIT 4`;
  const zero = await sql<{ id: string }[]>`
    SELECT id FROM links l WHERE NOT EXISTS (SELECT 1 FROM clicks c WHERE c.link_id = l.id)
    ORDER BY id LIMIT 5`;
  sample = {
    hot: hot.map((r) => Number(r.id)),
    cold: [meta.coldLink, ...cold.map((r) => Number(r.id))],
    zero: zero.map((r) => Number(r.id)),
  };
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe('consistência agregado × bruta (encurtador_bench)', () => {
  it('a amostra tem links quentes, frios e com 0 cliques', () => {
    expect(sample.hot).toHaveLength(3);
    expect(sample.cold.length).toBeGreaterThanOrEqual(2);
    expect(sample.zero.length).toBeGreaterThan(0);
  });

  it('links quentes: hourly, daily (com únicos), dimensões, prévias e click_count', async () => {
    expect(await allChecks(sql, linkScope(sample.hot), sample.hot)).toEqual([]);
  });

  it('links frios: idem', async () => {
    expect(await allChecks(sql, linkScope(sample.cold), sample.cold)).toEqual([]);
  });

  it('links com 0 cliques: nenhuma linha em agregado nenhum e click_count = 0', async () => {
    expect(await allChecks(sql, linkScope(sample.zero), sample.zero)).toEqual([]);
    const [r] = await sql<{ n: string }[]>`
      SELECT (SELECT count(*) FROM clicks_hourly WHERE link_id = ANY(${sample.zero}::bigint[]))
           + (SELECT count(*) FROM clicks_daily WHERE link_id = ANY(${sample.zero}::bigint[]))
           + (SELECT count(*) FROM clicks_daily_dim WHERE link_id = ANY(${sample.zero}::bigint[]))
           + (SELECT count(*) FROM clicks_daily_preview WHERE link_id = ANY(${sample.zero}::bigint[]))
           + (SELECT coalesce(sum(click_count), 0) FROM links WHERE id = ANY(${sample.zero}::bigint[])) AS n`;
    expect(Number(r!.n)).toBe(0);
  });

  it('todos os links em alguns dias: o primeiro, um de campanha, o último completo e hoje', async () => {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const [spike] = await sql<{ day: string }[]>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day FROM clicks_daily GROUP BY day ORDER BY sum(total) DESC LIMIT 1`;
    const days = [
      day(meta.startMs),
      spike!.day,
      day(meta.endMs - 86_400_000),
      day(meta.endMs),
      day(Date.now()),
    ];
    expect(await allChecks(sql, dayScope([...new Set(days)]))).toEqual([]);
  });

  it('clicks_daily inteiro (todos os links × todos os dias, com únicos) bate com a bruta', async () => {
    expect(await daily(sql, everything)).toEqual([]);
  });

  it('totais: bruta = hourly = daily por tipo; click_count = humanos; cada dimensão soma os humanos', async () => {
    const t = await totals(sql);
    expect(t.raw_total).toBeGreaterThan(0);
    expect(t.raw_total).toBeGreaterThanOrEqual(Number(meta.options.clicks));
    expect(t.hourly_total).toBe(t.raw_total);
    expect(t.daily_total).toBe(t.raw_total);
    expect(t.hourly_humans).toBe(t.raw_humans);
    expect(t.daily_humans).toBe(t.raw_humans);
    expect(t.daily_bots).toBe(t.raw_bots);
    expect(t.daily_previews).toBe(t.raw_previews);
    expect(t.preview_n).toBe(t.raw_previews);
    expect(t.click_count).toBe(t.raw_humans);
    expect(t.dim_min).toBe(t.raw_humans);
    expect(t.dim_max).toBe(t.raw_humans);
  });
});
