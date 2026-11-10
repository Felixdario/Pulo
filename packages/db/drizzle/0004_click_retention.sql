-- Retenção da bruta `clicks` (fase 8), irmã de `drop_old_visitor_partitions` (0002).
--
-- Derruba as partições mensais de `clicks` cujo mês terminou antes do corte e limpa o mesmo
-- período da DEFAULT. O corte é o 1º dia do mês corrente (UTC) menos `keep_months`: com
-- keep_months = 12, ficam os 12 meses completos anteriores e o mês corrente.
--
-- Os agregados (clicks_hourly, clicks_daily*, ADR 0006) não são tocados: o painel continua igual.
-- O que se perde é a bruta, então o `test:consistency` (agregados = bruta) deixa de valer para os
-- meses apagados; ele roda no `encurtador_bench`, onde a retenção fica desligada.
--
-- Por que DETACH sem CONCURRENTLY: o Postgres recusa `DETACH PARTITION … CONCURRENTLY` quando a
-- tabela tem partição DEFAULT ("cannot detach partitions concurrently when a default partition
-- exists", conferido no 16.15), e a `clicks` tem `clicks_default`. A forma CONCURRENTLY também não
-- roda dentro de transação nem de função. A forma comum pega ACCESS EXCLUSIVE na `clicks` por um
-- instante (só catálogo, sem varrer dados); o `lock_timeout` de 3 s faz a função desistir em vez de
-- enfileirar os INSERTs do worker atrás dela, e a próxima rodada tenta de novo.
CREATE OR REPLACE FUNCTION drop_old_click_partitions(keep_months integer)
RETURNS integer
LANGUAGE plpgsql
SET lock_timeout = '3s'
AS $$
DECLARE
  r record;
  dropped integer := 0;
  cutoff date;
BEGIN
  IF keep_months IS NULL OR keep_months < 1 THEN
    RAISE EXCEPTION 'keep_months precisa ser 1 ou mais (recebido %)', keep_months;
  END IF;
  -- Dois workers chamando juntos: o segundo espera e já encontra a lista atualizada.
  PERFORM pg_advisory_xact_lock(hashtext('drop_old_click_partitions'));
  cutoff := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => keep_months))::date;
  FOR r IN
    SELECT c.relname
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'clicks'::regclass
        AND c.relname ~ '^clicks_p[0-9]{4}_[0-9]{2}$'
      ORDER BY c.relname
  LOOP
    IF (to_date(substring(r.relname FROM '[0-9]{4}_[0-9]{2}$'), 'YYYY_MM') + interval '1 month')::date <= cutoff THEN
      EXECUTE format('ALTER TABLE clicks DETACH PARTITION %I', r.relname);
      EXECUTE format('DROP TABLE %I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  DELETE FROM clicks_default WHERE occurred_at < (cutoff::timestamp AT TIME ZONE 'UTC');
  RETURN dropped;
END
$$;
