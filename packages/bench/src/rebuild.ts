/**
 * `rebuild_aggregates(from_day, to_day)`: refaz os agregados de [from_day, to_day) (dias UTC) **a
 * partir da tabela bruta**, com a mesma semântica do `INSERT_BATCH` do worker
 * (`apps/worker/src/sql.ts`):
 *
 * - `clicks_hourly`: total/humanos/robôs/prévias por `date_trunc('hour', occurred_at, 'UTC')`;
 * - `clicks_daily`: o mesmo por dia UTC, e `uniques` = visitantes humanos distintos no link-dia
 *   (o que o worker conta com `click_visitors … ON CONFLICT DO NOTHING RETURNING`);
 * - `click_visitors`: um por (link, dia, visitante) humano;
 * - `clicks_daily_dim`: só humanos, nas 6 dimensões, com os mesmos `coalesce` e `<país>/<cidade>`;
 * - `clicks_daily_preview`: só prévias, `coalesce(preview_app, 'other')`;
 * - `links.click_count`: recebe a diferença de humanos do período (novo − antigo), travando as
 *   linhas de `links` em ordem de id como o worker, para duas reconstruções em paralelo (meses
 *   diferentes) não se travarem.
 *
 * É uma ferramenta de bench e de manutenção (backfill depois de um bug, por exemplo), por isso faz
 * COUNT na bruta: **não** é chamada pela API nem pelo worker e não está nas migrações. Rodar com o
 * worker parado para o período (ou com o período inteiro no passado), senão um lote que entra no
 * meio é apagado junto.
 */
export const REBUILD_AGGREGATES_SQL = `
CREATE OR REPLACE FUNCTION rebuild_aggregates(from_day date, to_day date)
RETURNS TABLE (raw_rows bigint, hourly_rows bigint, daily_rows bigint, dim_rows bigint,
               preview_rows bigint, visitor_rows bigint)
LANGUAGE plpgsql
AS $fn$
DECLARE
  lo timestamptz := from_day::timestamp AT TIME ZONE 'UTC';
  hi timestamptz := to_day::timestamp AT TIME ZONE 'UTC';
  n_raw bigint;
  n_h bigint;
  n_d bigint;
  n_dim bigint;
  n_p bigint;
  n_v bigint;
BEGIN
  IF from_day >= to_day THEN
    RAISE EXCEPTION 'intervalo vazio: [%, %)', from_day, to_day;
  END IF;

  DROP TABLE IF EXISTS pg_temp.rb_daily;
  CREATE TEMP TABLE rb_daily ON COMMIT DROP AS
    SELECT link_id, (occurred_at AT TIME ZONE 'UTC')::date AS day,
           count(*) AS total,
           count(*) FILTER (WHERE kind = 'human') AS humans,
           count(DISTINCT visitor) FILTER (WHERE kind = 'human') AS uniques,
           count(*) FILTER (WHERE kind = 'bot') AS bots,
           count(*) FILTER (WHERE kind = 'preview') AS previews
    FROM clicks
    WHERE occurred_at >= lo AND occurred_at < hi
    GROUP BY 1, 2;
  SELECT coalesce(sum(total), 0) INTO n_raw FROM rb_daily;

  -- O que o período somava em links.click_count, antes de apagar (ajustado no fim).
  DROP TABLE IF EXISTS pg_temp.rb_old;
  CREATE TEMP TABLE rb_old ON COMMIT DROP AS
    SELECT link_id, sum(humans) AS n FROM clicks_daily
    WHERE day >= from_day AND day < to_day GROUP BY link_id;

  DELETE FROM clicks_daily WHERE day >= from_day AND day < to_day;
  INSERT INTO clicks_daily (link_id, day, total, humans, uniques, bots, previews)
    SELECT link_id, day, total, humans, uniques, bots, previews FROM rb_daily ORDER BY 1, 2;
  GET DIAGNOSTICS n_d = ROW_COUNT;

  DELETE FROM clicks_hourly WHERE hour >= lo AND hour < hi;
  INSERT INTO clicks_hourly (link_id, hour, total, humans, bots, previews)
    SELECT link_id, date_trunc('hour', occurred_at, 'UTC'), count(*),
           count(*) FILTER (WHERE kind = 'human'),
           count(*) FILTER (WHERE kind = 'bot'),
           count(*) FILTER (WHERE kind = 'preview')
    FROM clicks
    WHERE occurred_at >= lo AND occurred_at < hi
    GROUP BY 1, 2
    ORDER BY 1, 2;
  GET DIAGNOSTICS n_h = ROW_COUNT;

  DELETE FROM click_visitors WHERE day >= from_day AND day < to_day;
  INSERT INTO click_visitors (link_id, day, visitor)
    SELECT DISTINCT link_id, (occurred_at AT TIME ZONE 'UTC')::date, visitor
    FROM clicks
    WHERE occurred_at >= lo AND occurred_at < hi AND kind = 'human';
  GET DIAGNOSTICS n_v = ROW_COUNT;

  DELETE FROM clicks_daily_dim WHERE day >= from_day AND day < to_day;
  INSERT INTO clicks_daily_dim (link_id, dim, day, value, n)
    SELECT i.link_id, v.dim, (i.occurred_at AT TIME ZONE 'UTC')::date, v.value, count(*)
    FROM clicks i
    CROSS JOIN LATERAL (VALUES
      ('country', coalesce(i.country, '(desconhecido)')),
      ('city', CASE WHEN i.city IS NULL THEN '(desconhecido)'
                    ELSE coalesce(i.country, '??') || '/' || i.city END),
      ('referrer', i.referrer_domain),
      ('browser', coalesce(i.browser, '(desconhecido)')),
      ('os', coalesce(i.os, '(desconhecido)')),
      ('device', i.device)
    ) AS v(dim, value)
    WHERE i.occurred_at >= lo AND i.occurred_at < hi AND i.kind = 'human'
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, 2, 3, 4;
  GET DIAGNOSTICS n_dim = ROW_COUNT;

  DELETE FROM clicks_daily_preview WHERE day >= from_day AND day < to_day;
  INSERT INTO clicks_daily_preview (link_id, day, app, n)
    SELECT link_id, (occurred_at AT TIME ZONE 'UTC')::date, coalesce(preview_app, 'other'), count(*)
    FROM clicks
    WHERE occurred_at >= lo AND occurred_at < hi AND kind = 'preview'
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3;
  GET DIAGNOSTICS n_p = ROW_COUNT;

  -- links.click_count por último: as linhas de links ficam travadas só até o COMMIT, e duas
  -- reconstruções em paralelo (meses diferentes) não esperam uma pela outra o tempo todo.
  WITH fresh AS (
    SELECT link_id, sum(humans) AS n FROM rb_daily GROUP BY link_id
  ), delta AS (
    SELECT link_id, coalesce(fresh.n, 0) - coalesce(rb_old.n, 0) AS d
    FROM rb_old FULL JOIN fresh USING (link_id)
  ), locked AS (
    SELECT id FROM links WHERE id IN (SELECT link_id FROM delta WHERE d <> 0) ORDER BY id FOR UPDATE
  )
  UPDATE links SET click_count = links.click_count + delta.d
  FROM delta, locked
  WHERE links.id = delta.link_id AND locked.id = delta.link_id;

  RETURN QUERY SELECT n_raw, n_h, n_d, n_dim, n_p, n_v;
END
$fn$;
`;
