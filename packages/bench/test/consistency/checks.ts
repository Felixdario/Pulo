import type { Sql } from 'postgres';

/**
 * Comparações agregado × bruta do teste de consistência (fase 5). Aqui o COUNT na tabela bruta é
 * permitido: é exatamente o que se quer conferir. Cada função devolve as linhas da **diferença
 * simétrica** (o que está num lado e não no outro, com a origem), no máximo `LIMIT` por consulta;
 * consistente = lista vazia.
 */
const LIMIT = 10;

export interface Diff {
  check: string;
  side: 'agregado' | 'bruta' | 'links';
  row: Record<string, unknown>;
}

/** Filtro sobre a bruta (`c`) e sobre o agregado (`a`), com a coluna de tempo de cada agregado. */
export interface Scope {
  /** Condição em SQL sobre `c` (tabela clicks). */
  raw: string;
  /** Condição sobre o agregado diário/dimensões/prévias (`a.link_id`, `a.day`). */
  day: string;
  /** Condição sobre o horário (`a.link_id`, `a.hour`). */
  hour: string;
}

export const linkScope = (linkIds: readonly number[]): Scope => {
  const list = linkIds.map((id) => `${Number(id)}`).join(',');
  return {
    raw: `c.link_id IN (${list})`,
    day: `a.link_id IN (${list})`,
    hour: `a.link_id IN (${list})`,
  };
};

export const dayScope = (days: readonly string[]): Scope => {
  const ranges = days.map((d) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new TypeError(`dia inválido: ${d}`);
    return d;
  });
  return {
    raw: `(${ranges.map((d) => `(c.occurred_at >= '${d} 00:00:00+00' AND c.occurred_at < '${d} 00:00:00+00'::timestamptz + interval '1 day')`).join(' OR ')})`,
    day: `a.day IN (${ranges.map((d) => `'${d}'::date`).join(',')})`,
    hour: `(${ranges.map((d) => `(a.hour >= '${d} 00:00:00+00' AND a.hour < '${d} 00:00:00+00'::timestamptz + interval '1 day')`).join(' OR ')})`,
  };
};

export const everything: Scope = { raw: 'true', day: 'true', hour: 'true' };

async function symmetric(sql: Sql, check: string, agg: string, raw: string): Promise<Diff[]> {
  const rows = await sql.unsafe<{ side: 'agregado' | 'bruta'; r: Record<string, unknown> }[]>(`
    WITH agg AS (${agg}), raw AS (${raw})
    (SELECT 'agregado' AS side, to_jsonb(x) AS r FROM (SELECT * FROM agg EXCEPT ALL SELECT * FROM raw) x LIMIT ${LIMIT})
    UNION ALL
    (SELECT 'bruta', to_jsonb(y) FROM (SELECT * FROM raw EXCEPT ALL SELECT * FROM agg) y LIMIT ${LIMIT})`);
  return rows.map((r) => ({ check, side: r.side, row: r.r }));
}

const KIND_COUNTS = `count(*) AS total, count(*) FILTER (WHERE c.kind = 'human') AS humans,
  count(*) FILTER (WHERE c.kind = 'bot') AS bots, count(*) FILTER (WHERE c.kind = 'preview') AS previews`;

export function hourly(sql: Sql, s: Scope) {
  return symmetric(
    sql,
    'clicks_hourly',
    `SELECT a.link_id, a.hour, a.total, a.humans, a.bots, a.previews FROM clicks_hourly a WHERE ${s.hour}`,
    `SELECT c.link_id, date_trunc('hour', c.occurred_at, 'UTC') AS hour, ${KIND_COUNTS}
     FROM clicks c WHERE ${s.raw} GROUP BY 1, 2`,
  );
}

export function daily(sql: Sql, s: Scope) {
  return symmetric(
    sql,
    'clicks_daily (total, humanos, robôs, prévias, únicos)',
    `SELECT a.link_id, a.day, a.total, a.humans, a.bots, a.previews, a.uniques FROM clicks_daily a WHERE ${s.day}`,
    `SELECT c.link_id, (c.occurred_at AT TIME ZONE 'UTC')::date AS day, ${KIND_COUNTS},
            count(DISTINCT c.visitor) FILTER (WHERE c.kind = 'human') AS uniques
     FROM clicks c WHERE ${s.raw} GROUP BY 1, 2`,
  );
}

export function dims(sql: Sql, s: Scope) {
  return symmetric(
    sql,
    'clicks_daily_dim',
    `SELECT a.link_id, a.dim, a.day, a.value, a.n FROM clicks_daily_dim a WHERE ${s.day}`,
    `SELECT c.link_id, v.dim, (c.occurred_at AT TIME ZONE 'UTC')::date AS day, v.value, count(*) AS n
     FROM clicks c
     CROSS JOIN LATERAL (VALUES
       ('country', coalesce(c.country, '(desconhecido)')),
       ('city', CASE WHEN c.city IS NULL THEN '(desconhecido)'
                     ELSE coalesce(c.country, '??') || '/' || c.city END),
       ('referrer', c.referrer_domain),
       ('browser', coalesce(c.browser, '(desconhecido)')),
       ('os', coalesce(c.os, '(desconhecido)')),
       ('device', c.device)) AS v(dim, value)
     WHERE c.kind = 'human' AND ${s.raw}
     GROUP BY 1, 2, 3, 4`,
  );
}

export function previews(sql: Sql, s: Scope) {
  return symmetric(
    sql,
    'clicks_daily_preview',
    `SELECT a.link_id, a.day, a.app, a.n FROM clicks_daily_preview a WHERE ${s.day}`,
    `SELECT c.link_id, (c.occurred_at AT TIME ZONE 'UTC')::date AS day,
            coalesce(c.preview_app, 'other') AS app, count(*) AS n
     FROM clicks c WHERE c.kind = 'preview' AND ${s.raw} GROUP BY 1, 2, 3`,
  );
}

/** links.click_count = humanos de todos os tempos na bruta (para os links dados, ou todos). */
export async function clickCount(sql: Sql, linkIds?: readonly number[]): Promise<Diff[]> {
  const where = linkIds ? `WHERE l.id IN (${linkIds.map(Number).join(',')})` : '';
  const rows = await sql.unsafe<{ id: string; click_count: string; raw: string }[]>(`
    SELECT l.id, l.click_count, coalesce(r.n, 0) AS raw
    FROM links l
    LEFT JOIN (SELECT link_id, count(*) AS n FROM clicks WHERE kind = 'human' GROUP BY 1) r
      ON r.link_id = l.id
    ${where}
    ${where ? 'AND' : 'WHERE'} l.click_count <> coalesce(r.n, 0)
    LIMIT ${LIMIT}`);
  return rows.map((r) => ({ check: 'links.click_count', side: 'links', row: r }));
}

/** Todas as comparações do escopo. */
export async function allChecks(sql: Sql, s: Scope, linkIds?: readonly number[]) {
  const out = [
    ...(await hourly(sql, s)),
    ...(await daily(sql, s)),
    ...(await dims(sql, s)),
    ...(await previews(sql, s)),
  ];
  if (linkIds) out.push(...(await clickCount(sql, linkIds)));
  return out;
}

/** Totais globais: cada agregado soma o mesmo que a bruta, por tipo. */
const TOTAL_KEYS = [
  'raw_total',
  'raw_humans',
  'raw_bots',
  'raw_previews',
  'hourly_total',
  'hourly_humans',
  'daily_total',
  'daily_humans',
  'daily_bots',
  'daily_previews',
  'click_count',
  'preview_n',
  'dim_min',
  'dim_max',
] as const;
export type Totals = Record<(typeof TOTAL_KEYS)[number], number>;

export async function totals(sql: Sql): Promise<Totals> {
  const [r] = await sql<Record<string, string | null>[]>`
    SELECT
      (SELECT count(*) FROM clicks) AS raw_total,
      (SELECT count(*) FROM clicks WHERE kind = 'human') AS raw_humans,
      (SELECT count(*) FROM clicks WHERE kind = 'bot') AS raw_bots,
      (SELECT count(*) FROM clicks WHERE kind = 'preview') AS raw_previews,
      (SELECT sum(total) FROM clicks_hourly) AS hourly_total,
      (SELECT sum(humans) FROM clicks_hourly) AS hourly_humans,
      (SELECT sum(total) FROM clicks_daily) AS daily_total,
      (SELECT sum(humans) FROM clicks_daily) AS daily_humans,
      (SELECT sum(bots) FROM clicks_daily) AS daily_bots,
      (SELECT sum(previews) FROM clicks_daily) AS daily_previews,
      (SELECT sum(click_count) FROM links) AS click_count,
      (SELECT sum(n) FROM clicks_daily_preview) AS preview_n,
      (SELECT min(s) FROM (SELECT sum(n) AS s FROM clicks_daily_dim GROUP BY dim) d) AS dim_min,
      (SELECT max(s) FROM (SELECT sum(n) AS s FROM clicks_daily_dim GROUP BY dim) d) AS dim_max`;
  return Object.fromEntries(TOTAL_KEYS.map((k) => [k, Number(r?.[k] ?? 0)])) as Totals;
}
