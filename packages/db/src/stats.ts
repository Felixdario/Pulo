import { sql, type SQL } from 'drizzle-orm';
import type { ClickDimension } from './analytics';
import type { Executor } from './links';

/**
 * Consultas de estatísticas da API (ADR 0004). Só leem os agregados do worker (`clicks_hourly`,
 * `clicks_daily`, `clicks_daily_dim`, `clicks_daily_preview`), nunca a tabela bruta de cliques.
 * Cada consulta filtra pelo prefixo da PK (`link_id`, …) e por intervalo na coluna de tempo, então
 * vira varredura de intervalo no índice da PK. `test/integration/stats.test.ts` roda `EXPLAIN` em
 * todas, com dados e ANALYZE, e falha se aparecer Seq Scan num agregado ou qualquer leitura da tabela
 * bruta. Planos medidos no teste (1.000 links × 120 dias, PostgreSQL 16; `PLANS_FILE=… ` grava o
 * EXPLAIN completo):
 *
 * hourlySeriesQuery (hour; day/month fora de UTC)
 *   Merge Left Join (g.bucket = s.bucket)
 *     -> Sort -> Nested Loop -> CTE Scan on r -> Function Scan on generate_series g
 *     -> Sort -> HashAggregate (date_trunc(…, h.hour, tz)) -> Nested Loop -> CTE Scan on r
 *          -> Bitmap Heap Scan on clicks_hourly h
 *               -> Bitmap Index Scan on clicks_hourly_pkey
 *                    Index Cond: ((link_id = 1) AND (hour >= r.lo) AND (hour < r.hi))
 * dailySeriesQuery (day/month em UTC)
 *   Sort -> Hash Left Join -> Function Scan on generate_series g
 *     -> HashAggregate -> Bitmap Heap Scan on clicks_daily
 *          -> Bitmap Index Scan on clicks_daily_pkey
 *               Index Cond: ((link_id = 1) AND (day >= '…'::date) AND (day < '…'::date))
 * topDimensionQuery
 *   Limit -> Sort -> WindowAgg -> HashAggregate -> Bitmap Heap Scan on clicks_daily_dim
 *     -> Bitmap Index Scan on clicks_daily_dim_pkey
 *          Index Cond: ((link_id = 1) AND (dim = 'country') AND (day >= …) AND (day < …))
 * summaryQuery / previewAppsQuery
 *   Aggregate -> Bitmap Heap Scan on clicks_daily -> Bitmap Index Scan on clicks_daily_pkey
 *   HashAggregate -> Bitmap Heap Scan on clicks_daily_preview
 *     -> Bitmap Index Scan on clicks_daily_preview_pkey
 * accountSeriesQuery / accountTopLinksQuery
 *   HashAggregate -> Nested Loop
 *     -> links l (Bitmap Index Scan por user_id, ou Seq Scan: links é pequena e não é agregado)
 *     -> Bitmap Heap Scan on clicks_daily d -> Bitmap Index Scan on clicks_daily_pkey
 *          Index Cond: ((link_id = l.id) AND (day >= '…'::date) AND (day < '…'::date))
 */

export type Granularity = 'hour' | 'day' | 'month';

export interface SeriesPoint {
  /** Início do balde, instante UTC em ISO 8601. */
  start: string;
  /** Início do balde no fuso pedido: `AAAA-MM-DDTHH:MM`, `AAAA-MM-DD` ou `AAAA-MM`. */
  label: string;
  total: number;
  humans: number;
  /** Só com `day` em UTC (soma de visitantes únicos por dia UTC); `null` nos outros casos. */
  uniques: number | null;
  bots: number;
  previews: number;
}

export interface TimeseriesParams {
  linkId: number;
  granularity: Granularity;
  /** Instantes; o intervalo é alinhado aos baldes do fuso: [início do balde de `from`, fim do de `to`). */
  from: Date;
  to: Date;
  /** Nome IANA (`America/Sao_Paulo`) ou `UTC`. */
  tz: string;
}

export interface TimeseriesResult {
  /** Qual agregado respondeu: `hourly` soma horas (converte fuso), `daily` lê o dia UTC pronto. */
  source: 'hourly' | 'daily';
  points: SeriesPoint[];
}

const LABEL_FORMAT: Record<Granularity, string> = {
  hour: 'YYYY-MM-DD"T"HH24:MI',
  day: 'YYYY-MM-DD',
  month: 'YYYY-MM',
};

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

type Row = Record<string, unknown>;
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

const isUtc = (tz: string) => tz === 'UTC' || tz === 'Etc/UTC';

/** Dia UTC (`AAAA-MM-DD`) de um instante. */
export const utcDate = (d: Date) => d.toISOString().slice(0, 10);

const addDays = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDate(d);
};

/** [primeiro dia, dia seguinte ao último) em UTC, cobrindo os instantes [from, to). */
function utcDayRange(from: Date, to: Date): [string, string] {
  const lo = utcDate(from);
  const last = utcDate(new Date(to.getTime() - 1));
  return [lo, addDays(last, 1)];
}

/** Escolha da fonte (ADR 0004): `hour`, ou `day`/`month` fora de UTC, somam o `clicks_hourly`. */
export function timeseriesSource(granularity: Granularity, tz: string): 'hourly' | 'daily' {
  return granularity === 'hour' || !isUtc(tz) ? 'hourly' : 'daily';
}

/** SQL da série a partir do `clicks_hourly` (qualquer fuso). Exportado para o teste de EXPLAIN. */
export function hourlySeriesQuery(p: TimeseriesParams): SQL {
  const step = `1 ${p.granularity}`;
  return sql`
    WITH r AS (
      SELECT date_trunc(${p.granularity}, ${p.from.toISOString()}::timestamptz, ${p.tz}) AS lo,
             date_add(
               date_trunc(${p.granularity}, ${p.to.toISOString()}::timestamptz - interval '1 microsecond', ${p.tz}),
               ${step}::interval, ${p.tz}) AS hi
    ),
    s AS (
      SELECT date_trunc(${p.granularity}, h.hour, ${p.tz}) AS bucket,
             sum(h.total) AS total, sum(h.humans) AS humans, sum(h.bots) AS bots,
             sum(h.previews) AS previews
      FROM r, clicks_hourly h
      WHERE h.link_id = ${p.linkId} AND h.hour >= r.lo AND h.hour < r.hi
      GROUP BY 1
    )
    SELECT to_char(g.bucket AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS start,
           to_char(g.bucket AT TIME ZONE ${p.tz}, ${LABEL_FORMAT[p.granularity]}) AS label,
           s.total, s.humans, s.bots, s.previews
    FROM r
    CROSS JOIN LATERAL generate_series(r.lo, r.hi - interval '1 microsecond', ${step}::interval, ${p.tz}) AS g(bucket)
    LEFT JOIN s ON s.bucket = g.bucket
    ORDER BY g.bucket`;
}

/** SQL da série a partir do `clicks_daily` (dia ou mês em UTC). Exportado para o teste de EXPLAIN. */
export function dailySeriesQuery(p: TimeseriesParams): SQL {
  let [lo, hi] = utcDayRange(p.from, p.to);
  if (p.granularity === 'month') {
    lo = `${lo.slice(0, 7)}-01`;
    const last = new Date(`${addDays(hi, -1).slice(0, 7)}-01T00:00:00Z`);
    last.setUTCMonth(last.getUTCMonth() + 1);
    hi = utcDate(last);
  }
  const unit = p.granularity === 'month' ? 'month' : 'day';
  return sql`
    WITH s AS (
      SELECT date_trunc(${unit}, day::timestamp)::date AS bucket,
             sum(total) AS total, sum(humans) AS humans, sum(uniques) AS uniques,
             sum(bots) AS bots, sum(previews) AS previews
      FROM public.clicks_daily
      WHERE link_id = ${p.linkId} AND day >= ${lo}::date AND day < ${hi}::date
      GROUP BY 1
    )
    SELECT to_char(g.bucket, 'YYYY-MM-DD"T00:00:00Z"') AS start,
           to_char(g.bucket, ${LABEL_FORMAT[p.granularity]}) AS label,
           s.total, s.humans, s.uniques, s.bots, s.previews
    FROM generate_series(${lo}::timestamp, ${hi}::timestamp - ${`1 ${unit}`}::interval,
                         ${`1 ${unit}`}::interval) AS g(bucket)
    LEFT JOIN s ON s.bucket = g.bucket::date
    ORDER BY g.bucket`;
}

export async function timeseries(db: Executor, p: TimeseriesParams): Promise<TimeseriesResult> {
  const source = timeseriesSource(p.granularity, p.tz);
  const query = source === 'hourly' ? hourlySeriesQuery(p) : dailySeriesQuery(p);
  const withUniques = source === 'daily' && p.granularity === 'day';
  const rows = (await db.execute(query)) as unknown as Row[];
  return {
    source,
    points: rows.map((r) => ({
      start: String(r.start),
      label: String(r.label),
      total: n(r.total),
      humans: n(r.humans),
      uniques: withUniques ? n(r.uniques) : null,
      bots: n(r.bots),
      previews: n(r.previews),
    })),
  };
}

export interface DayRange {
  linkId: number;
  /** Primeiro dia UTC (inclusive), `AAAA-MM-DD`. */
  fromDay: string;
  /** Dia UTC seguinte ao último (exclusivo). */
  toDay: string;
}

export interface TopResult {
  items: { value: string; n: number }[];
  /** Soma dos valores fora do top N. */
  others: number;
  total: number;
}

export function topDimensionQuery(p: DayRange & { dim: ClickDimension; limit: number }): SQL {
  return sql`
    SELECT value, n, sum(n) OVER () AS grand
    FROM (
      SELECT value, sum(n) AS n
      FROM public.clicks_daily_dim
      WHERE link_id = ${p.linkId} AND dim = ${p.dim}
        AND day >= ${p.fromDay}::date AND day < ${p.toDay}::date
      GROUP BY value
    ) t
    ORDER BY n DESC, value
    LIMIT ${p.limit}`;
}

/** Top N valores de uma dimensão (só cliques humanos) e o resto somado em `others`. */
export async function topDimension(
  db: Executor,
  p: DayRange & { dim: ClickDimension; limit: number },
): Promise<TopResult> {
  const rows = (await db.execute(topDimensionQuery(p))) as unknown as Row[];
  const items = rows.map((r) => ({ value: String(r.value), n: n(r.n) }));
  const total = rows.length > 0 ? n(rows[0]!.grand) : 0;
  return { items, others: total - items.reduce((s, i) => s + i.n, 0), total };
}

export interface SummaryTotals {
  total: number;
  humans: number;
  /** Soma dos únicos de cada dia UTC (um visitante que volta em outro dia conta de novo). */
  uniques: number;
  bots: number;
  previews: number;
}

export function summaryQuery(p: DayRange): SQL {
  return sql`
    SELECT coalesce(sum(total), 0) AS total, coalesce(sum(humans), 0) AS humans,
           coalesce(sum(uniques), 0) AS uniques, coalesce(sum(bots), 0) AS bots,
           coalesce(sum(previews), 0) AS previews
    FROM public.clicks_daily
    WHERE link_id = ${p.linkId} AND day >= ${p.fromDay}::date AND day < ${p.toDay}::date`;
}

export function previewAppsQuery(p: DayRange): SQL {
  return sql`
    SELECT app, sum(n) AS n
    FROM public.clicks_daily_preview
    WHERE link_id = ${p.linkId} AND day >= ${p.fromDay}::date AND day < ${p.toDay}::date
    GROUP BY app
    ORDER BY 2 DESC, app`;
}

export async function linkSummary(
  db: Executor,
  p: DayRange,
): Promise<SummaryTotals & { previewApps: { app: string; n: number }[] }> {
  const [totals, apps] = await Promise.all([
    db.execute(summaryQuery(p)) as unknown as Promise<Row[]>,
    db.execute(previewAppsQuery(p)) as unknown as Promise<Row[]>,
  ]);
  const t = totals[0] ?? {};
  return {
    total: n(t.total),
    humans: n(t.humans),
    uniques: n(t.uniques),
    bots: n(t.bots),
    previews: n(t.previews),
    previewApps: apps.map((r) => ({ app: String(r.app), n: n(r.n) })),
  };
}

export interface AccountRange {
  userId: number;
  fromDay: string;
  toDay: string;
}

export function accountSeriesQuery(p: AccountRange): SQL {
  return sql`
    WITH s AS (
      SELECT d.day, sum(d.total) AS total, sum(d.humans) AS humans, sum(d.bots) AS bots,
             sum(d.previews) AS previews
      FROM links l
      JOIN clicks_daily d ON d.link_id = l.id
      WHERE l.user_id = ${p.userId} AND l.deleted_at IS NULL
        AND d.day >= ${p.fromDay}::date AND d.day < ${p.toDay}::date
      GROUP BY d.day
    )
    SELECT to_char(g.day, 'YYYY-MM-DD') AS day, s.total, s.humans, s.bots, s.previews
    FROM generate_series(${p.fromDay}::timestamp, ${p.toDay}::timestamp - interval '1 day',
                         interval '1 day') AS g(day)
    LEFT JOIN s ON s.day = g.day::date
    ORDER BY g.day`;
}

export function accountTopLinksQuery(p: AccountRange & { limit: number }): SQL {
  return sql`
    SELECT l.id, l.slug, l.title, sum(d.total) AS total, sum(d.humans) AS humans
    FROM links l
    JOIN clicks_daily d ON d.link_id = l.id
    WHERE l.user_id = ${p.userId} AND l.deleted_at IS NULL
      AND d.day >= ${p.fromDay}::date AND d.day < ${p.toDay}::date
    GROUP BY l.id, l.slug, l.title
    ORDER BY humans DESC, l.id DESC
    LIMIT ${p.limit}`;
}

export interface AccountOverview {
  linksTotal: number;
  series: { day: string; total: number; humans: number; bots: number; previews: number }[];
  topLinks: { id: number; slug: string; title: string | null; total: number; humans: number }[];
}

export async function accountOverview(
  db: Executor,
  p: AccountRange & { limit: number },
): Promise<AccountOverview> {
  const [count, series, top] = await Promise.all([
    db.execute(
      sql`SELECT count(*) AS n FROM links WHERE user_id = ${p.userId} AND deleted_at IS NULL`,
    ) as unknown as Promise<Row[]>,
    db.execute(accountSeriesQuery(p)) as unknown as Promise<Row[]>,
    db.execute(accountTopLinksQuery(p)) as unknown as Promise<Row[]>,
  ]);
  return {
    linksTotal: n(count[0]?.n),
    series: series.map((r) => ({
      day: String(r.day),
      total: n(r.total),
      humans: n(r.humans),
      bots: n(r.bots),
      previews: n(r.previews),
    })),
    topLinks: top.map((r) => ({
      id: n(r.id),
      slug: String(r.slug),
      title: r.title === null ? null : String(r.title),
      total: n(r.total),
      humans: n(r.humans),
    })),
  };
}
