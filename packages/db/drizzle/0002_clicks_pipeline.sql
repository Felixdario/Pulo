-- Fase 3 (ADR 0003): pipeline de cliques. SQL escrito à mão porque o Drizzle não gera
-- PARTITION BY nem funções. Nenhuma coluna guarda IP: o redirect manda só `visitor` (HMAC com sal
-- diário) e `ip_net` (truncado), e o worker usa o `ip_net` para a geolocalização e o descarta.

-- Linhas brutas, uma por clique, particionadas por mês (UTC). A chave única inclui a coluna de
-- partição; `occurred_at` vem do evento e é determinístico, então a reentrega cai no ON CONFLICT.
CREATE TABLE clicks (
  event_id uuid NOT NULL,
  link_id bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL CONSTRAINT clicks_kind_check CHECK (kind IN ('human', 'bot', 'preview')),
  visitor text NOT NULL CONSTRAINT clicks_visitor_check CHECK (visitor ~ '^[A-Za-z0-9_-]{22}$'),
  country char(2) CONSTRAINT clicks_country_check CHECK (country ~ '^[A-Z]{2}$'),
  city text,
  region text,
  referrer_domain text NOT NULL,
  browser text,
  os text,
  device text NOT NULL,
  preview_app text,
  CONSTRAINT clicks_pkey PRIMARY KEY (occurred_at, event_id)
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint
CREATE INDEX clicks_link_time_idx ON clicks (link_id, occurred_at);
--> statement-breakpoint
CREATE TABLE clicks_default PARTITION OF clicks DEFAULT;
--> statement-breakpoint

-- Visitantes únicos por link e dia (UTC). Só serve para deduplicar o dia corrente e para o teste de
-- consistência; as partições mensais são descartadas depois de 90 dias.
CREATE TABLE click_visitors (
  link_id bigint NOT NULL,
  day date NOT NULL,
  visitor text NOT NULL,
  CONSTRAINT click_visitors_pkey PRIMARY KEY (link_id, day, visitor)
) PARTITION BY RANGE (day);
--> statement-breakpoint
CREATE TABLE click_visitors_default PARTITION OF click_visitors DEFAULT;
--> statement-breakpoint

-- Agregados lidos pelo dashboard (nunca contagem na tabela bruta).
CREATE TABLE clicks_hourly (
  link_id bigint NOT NULL,
  hour timestamptz NOT NULL,
  total bigint NOT NULL DEFAULT 0,
  humans bigint NOT NULL DEFAULT 0,
  bots bigint NOT NULL DEFAULT 0,
  previews bigint NOT NULL DEFAULT 0,
  CONSTRAINT clicks_hourly_pkey PRIMARY KEY (link_id, hour)
);
--> statement-breakpoint
CREATE TABLE clicks_daily (
  link_id bigint NOT NULL,
  day date NOT NULL,
  total bigint NOT NULL DEFAULT 0,
  humans bigint NOT NULL DEFAULT 0,
  uniques bigint NOT NULL DEFAULT 0,
  bots bigint NOT NULL DEFAULT 0,
  previews bigint NOT NULL DEFAULT 0,
  CONSTRAINT clicks_daily_pkey PRIMARY KEY (link_id, day)
);
--> statement-breakpoint

-- Uma tabela para todas as dimensões (só humanos). A PK (link_id, dim, day, value) serve direto o
-- "top N valores da dimensão D do link L no período": varredura de intervalo contígua no índice.
CREATE TABLE clicks_daily_dim (
  link_id bigint NOT NULL,
  dim text NOT NULL CONSTRAINT clicks_daily_dim_dim_check
    CHECK (dim IN ('country', 'city', 'referrer', 'browser', 'os', 'device')),
  day date NOT NULL,
  value text NOT NULL,
  n bigint NOT NULL DEFAULT 0,
  CONSTRAINT clicks_daily_dim_pkey PRIMARY KEY (link_id, dim, day, value)
);
--> statement-breakpoint
CREATE TABLE clicks_daily_preview (
  link_id bigint NOT NULL,
  day date NOT NULL,
  app text NOT NULL,
  n bigint NOT NULL DEFAULT 0,
  CONSTRAINT clicks_daily_preview_pkey PRIMARY KEY (link_id, day, app)
);
--> statement-breakpoint

-- Cria as partições mensais de [from_month, to_month] (meses inclusivos) de uma tabela
-- particionada por RANGE na coluna `key`. Idempotente e segura com dois workers subindo juntos
-- (advisory lock). Se a partição DEFAULT já tem linhas do mês, elas são movidas antes do ATTACH.
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(parent regclass, key text, from_month date, to_month date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  m date := date_trunc('month', from_month)::date;
  last_month date := date_trunc('month', to_month)::date;
  base text;
  is_tz boolean;
  default_part text;
  part text;
  lo text;
  hi text;
  created integer := 0;
BEGIN
  SELECT relname INTO base FROM pg_class WHERE oid = parent;
  PERFORM pg_advisory_xact_lock(hashtext('ensure_monthly_partitions:' || base));
  SELECT format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone' INTO is_tz
    FROM pg_attribute a WHERE a.attrelid = parent AND a.attname = key;
  IF is_tz IS NULL THEN
    RAISE EXCEPTION 'coluna % não existe em %', key, base;
  END IF;
  SELECT c.relname INTO default_part
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = parent AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT';

  WHILE m <= last_month LOOP
    part := format('%s_p%s', base, to_char(m, 'YYYY_MM'));
    IF to_regclass(part) IS NULL THEN
      IF is_tz THEN
        lo := m::text || ' 00:00:00+00';
        hi := (m + interval '1 month')::date::text || ' 00:00:00+00';
      ELSE
        lo := m::text;
        hi := (m + interval '1 month')::date::text;
      END IF;
      EXECUTE format('CREATE TABLE %I (LIKE %s INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', part, parent);
      IF default_part IS NOT NULL THEN
        EXECUTE format(
          'WITH moved AS (DELETE FROM %I WHERE %I >= %L AND %I < %L RETURNING *) INSERT INTO %I SELECT * FROM moved',
          default_part, key, lo, key, hi, part);
      END IF;
      EXECUTE format('ALTER TABLE %s ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', parent, part, lo, hi);
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ensure_click_partitions(from_month date, to_month date)
RETURNS integer
LANGUAGE sql
AS $$
  SELECT ensure_monthly_partitions('clicks', 'occurred_at', from_month, to_month)
       + ensure_monthly_partitions('click_visitors', 'day', from_month, to_month)
$$;
--> statement-breakpoint

-- Retenção de `click_visitors`: derruba as partições mensais que terminaram há mais de `keep_days`
-- dias e limpa o mesmo período da DEFAULT. Não é chamada automaticamente contra o banco de dev.
CREATE OR REPLACE FUNCTION drop_old_visitor_partitions(keep_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  dropped integer := 0;
  cutoff date := current_date - keep_days;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'click_visitors'::regclass
        AND c.relname ~ '^click_visitors_p[0-9]{4}_[0-9]{2}$'
  LOOP
    IF (to_date(substring(r.relname FROM '[0-9]{4}_[0-9]{2}$'), 'YYYY_MM') + interval '1 month')::date <= cutoff THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  DELETE FROM click_visitors_default WHERE day < cutoff;
  RETURN dropped;
END
$$;
--> statement-breakpoint
SELECT ensure_click_partitions(date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month')::date);
