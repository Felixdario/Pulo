import type { Sql } from 'postgres';
import type { ClickRow } from './events';

/**
 * Uma instrução só (ADR 0003): os CTEs que modificam dados enxergam o mesmo snapshot e a instrução
 * é atômica, então ou entram a linha bruta e todos os agregados, ou nada. Os agregados só somam o
 * que o RETURNING do INSERT bruto devolveu: um evento reentregue não insere linha e não soma em lugar
 * nenhum.
 *
 * Cada INSERT … SELECT leva ORDER BY pela chave de conflito, para que workers concorrentes tomem os
 * locks na mesma ordem. Eventos de link inexistente são descartados no CTE `input`.
 *
 * Dimensões (só humanos): valores ausentes viram "(desconhecido)"; cidade é gravada como
 * "<país>/<cidade>" para não juntar cidades homônimas de países diferentes.
 */
export const INSERT_BATCH = `
WITH input AS (
  SELECT u.*
  FROM unnest(
    $1::uuid[], $2::bigint[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[],
    $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[]
  ) AS u(event_id, link_id, occurred_at, kind, visitor, country, city, region, referrer_domain,
         browser, os, device, preview_app)
  WHERE EXISTS (SELECT 1 FROM links l WHERE l.id = u.link_id)
),
ins AS (
  INSERT INTO clicks (event_id, link_id, occurred_at, kind, visitor, country, city, region,
                      referrer_domain, browser, os, device, preview_app)
  SELECT event_id, link_id, occurred_at, kind, visitor, country, city, region, referrer_domain,
         browser, os, device, preview_app
  FROM input
  ORDER BY occurred_at, event_id
  ON CONFLICT (occurred_at, event_id) DO NOTHING
  RETURNING link_id, occurred_at, (occurred_at AT TIME ZONE 'UTC')::date AS day, kind, visitor,
            country, city, referrer_domain, browser, os, device, preview_app
),
new_visitors AS (
  INSERT INTO click_visitors (link_id, day, visitor)
  SELECT DISTINCT link_id, day, visitor FROM ins WHERE kind = 'human'
  ORDER BY link_id, day, visitor
  ON CONFLICT DO NOTHING
  RETURNING link_id, day
),
agg_hour AS (
  INSERT INTO clicks_hourly AS h (link_id, hour, total, humans, bots, previews)
  SELECT link_id, date_trunc('hour', occurred_at, 'UTC'), count(*),
         count(*) FILTER (WHERE kind = 'human'),
         count(*) FILTER (WHERE kind = 'bot'),
         count(*) FILTER (WHERE kind = 'preview')
  FROM ins
  GROUP BY 1, 2
  ORDER BY 1, 2
  ON CONFLICT (link_id, hour) DO UPDATE SET
    total = h.total + EXCLUDED.total,
    humans = h.humans + EXCLUDED.humans,
    bots = h.bots + EXCLUDED.bots,
    previews = h.previews + EXCLUDED.previews
),
agg_day AS (
  INSERT INTO clicks_daily AS d (link_id, day, total, humans, uniques, bots, previews)
  SELECT c.link_id, c.day, c.total, c.humans, coalesce(v.n, 0), c.bots, c.previews
  FROM (
    SELECT link_id, day, count(*) AS total,
           count(*) FILTER (WHERE kind = 'human') AS humans,
           count(*) FILTER (WHERE kind = 'bot') AS bots,
           count(*) FILTER (WHERE kind = 'preview') AS previews
    FROM ins GROUP BY link_id, day
  ) c
  LEFT JOIN (SELECT link_id, day, count(*) AS n FROM new_visitors GROUP BY link_id, day) v
    ON v.link_id = c.link_id AND v.day = c.day
  ORDER BY 1, 2
  ON CONFLICT (link_id, day) DO UPDATE SET
    total = d.total + EXCLUDED.total,
    humans = d.humans + EXCLUDED.humans,
    uniques = d.uniques + EXCLUDED.uniques,
    bots = d.bots + EXCLUDED.bots,
    previews = d.previews + EXCLUDED.previews
),
agg_dim AS (
  INSERT INTO clicks_daily_dim AS x (link_id, dim, day, value, n)
  SELECT i.link_id, v.dim, i.day, v.value, count(*)
  FROM ins i
  CROSS JOIN LATERAL (VALUES
    ('country', coalesce(i.country, '(desconhecido)')),
    ('city', CASE WHEN i.city IS NULL THEN '(desconhecido)'
                  ELSE coalesce(i.country, '??') || '/' || i.city END),
    ('referrer', i.referrer_domain),
    ('browser', coalesce(i.browser, '(desconhecido)')),
    ('os', coalesce(i.os, '(desconhecido)')),
    ('device', i.device)
  ) AS v(dim, value)
  WHERE i.kind = 'human'
  GROUP BY 1, 2, 3, 4
  ORDER BY 1, 2, 3, 4
  ON CONFLICT (link_id, dim, day, value) DO UPDATE SET n = x.n + EXCLUDED.n
),
agg_preview AS (
  INSERT INTO clicks_daily_preview AS p (link_id, day, app, n)
  SELECT link_id, day, coalesce(preview_app, 'other'), count(*)
  FROM ins WHERE kind = 'preview'
  GROUP BY 1, 2, 3
  ORDER BY 1, 2, 3
  ON CONFLICT (link_id, day, app) DO UPDATE SET n = p.n + EXCLUDED.n
),
-- O UPDATE … FROM não tem ordem de junção garantida; travar as linhas de links antes, em ordem de
-- id (LockRows acima do Sort), evita o ciclo entre dois workers com links em comum.
locked_links AS (
  SELECT id FROM links
  WHERE id IN (SELECT link_id FROM ins WHERE kind = 'human')
  ORDER BY id
  FOR UPDATE
),
link_counts AS (
  UPDATE links SET click_count = links.click_count + c.n
  FROM (SELECT link_id, count(*) AS n FROM ins WHERE kind = 'human' GROUP BY link_id) c,
       locked_links k
  WHERE links.id = c.link_id AND k.id = c.link_id
  RETURNING links.id
)
-- Linhas novas (para métricas e o PUBLISH ao vivo) + uma linha-resumo com quantos eventos do lote
-- eram de link existente: separa "duplicado" (conhecido, mas o ON CONFLICT descartou) de "link
-- inexistente" (filtrado em input). A contagem é sobre o CTE do lote, nunca sobre a tabela clicks.
SELECT i.link_id::text AS link_id, l.user_id::text AS user_id, i.kind, NULL::bigint AS known
FROM ins i JOIN links l ON l.id = i.link_id
UNION ALL
SELECT NULL, NULL, NULL, (SELECT count(*) FROM input)
`;

export interface InsertedClick {
  link_id: string;
  user_id: string | null;
  kind: 'human' | 'bot' | 'preview';
}

export interface BatchResult {
  inserted: InsertedClick[];
  /** Eventos do lote cujo link existe (inseridos + duplicados). */
  known: number;
}

/**
 * Literal de array do Postgres (`{"a","b",NULL}`), com cada elemento entre aspas e `"`/`\`
 * escapados. Vai como um parâmetro de texto; o `::tipo[]` da instrução converte.
 */
export function pgArray(values: readonly (string | null)[]): string {
  return `{${values
    .map((v) => (v === null ? 'NULL' : `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`))
    .join(',')}}`;
}

/** Executa a instrução única para o lote. Devolve as linhas brutas novas e quantos eram conhecidos. */
export async function insertBatch(sql: Sql, rows: readonly ClickRow[]): Promise<BatchResult> {
  if (rows.length === 0) return { inserted: [], known: 0 };
  const col = <K extends keyof ClickRow>(k: K) => pgArray(rows.map((r) => r[k]));
  const params = [
    col('eventId'),
    col('linkId'),
    col('occurredAt'),
    col('kind'),
    col('visitor'),
    col('country'),
    col('city'),
    col('region'),
    col('referrerDomain'),
    col('browser'),
    col('os'),
    col('device'),
    col('previewApp'),
  ];
  const out = (await sql.unsafe(INSERT_BATCH, params as never)) as unknown as (InsertedClick & {
    known: string | null;
  })[];
  let known = 0;
  const inserted: InsertedClick[] = [];
  for (const r of out) {
    if (r.known !== null) known = Number(r.known);
    else inserted.push({ link_id: r.link_id, user_id: r.user_id, kind: r.kind });
  }
  return { inserted, known };
}

/** Erros do Postgres que valem repetir o lote inteiro (conexão, serialização, deadlock, shutdown). */
export function isTransient(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? '';
  if (/^(08|53|57)/.test(code)) return true;
  if (code === '40001' || code === '40P01') return true;
  const msg = err instanceof Error ? err.message : '';
  return (
    /ECONNREFUSED|ECONNRESET|CONNECTION_|ETIMEDOUT|EPIPE/i.test(msg) || /CONNECT_TIMEOUT/.test(code)
  );
}

/** Garante as partições do mês corrente e do próximo (idempotente). */
export async function ensurePartitions(sql: Sql, now = new Date()): Promise<number> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const [row] = await sql<{ n: number }[]>`
    SELECT ensure_click_partitions(${from.toISOString().slice(0, 10)}::date, ${to
      .toISOString()
      .slice(0, 10)}::date) AS n`;
  return row?.n ?? 0;
}

/**
 * Retenção da bruta: `drop_old_click_partitions(meses)` (migração 0004) derruba as partições
 * mensais de `clicks` mais antigas que N meses completos. Cada chamada do postgres.js é um comando
 * em autocommit, então a função roda numa transação curta só dela (DETACH sem CONCURRENTLY, porque
 * a `clicks` tem DEFAULT; ver o comentário da migração).
 */
export async function dropOldClickPartitions(sql: Sql, months: number): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT drop_old_click_partitions(${months}::int) AS n`;
  return row?.n ?? 0;
}
