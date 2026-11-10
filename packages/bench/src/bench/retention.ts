/**
 * `corepack pnpm bench:retention`
 *
 * Retenção da bruta: apagar o mês mais antigo com `DELETE … WHERE` numa tabela monolítica
 * (`clicks_flat`, a cópia não particionada do bench:analytics) contra `DETACH PARTITION` + `DROP`
 * numa particionada com os mesmos dados (`ret_clicks`, dois meses copiados da `clicks`, com a PK e o
 * índice da migração). Mede tempo, WAL gerado, tuplas mortas, tamanho antes/depois e o que o VACUUM
 * (e o VACUUM FULL) devolvem. Também roda a função que já existe para `click_visitors`
 * (`drop_old_visitor_partitions(90)`, migração 0002) no bench.
 *
 * A `clicks` real não perde nada (os agregados continuam batendo com a bruta). A `clicks_flat` sai
 * inchada e é apagada no fim; o bench:analytics a recria se rodar de novo.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { benchSql, fmtBytes, fmtInt, readMeta } from '../bench-db';

const RESULTS = new URL('../../results/', import.meta.url);

const wal = async (sql: Sql) =>
  BigInt(
    (
      await sql<{ b: string }[]>`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint AS b`
    )[0]!.b,
  );

async function timed(sql: Sql, label: string, stmt: string) {
  const w0 = await wal(sql);
  const t0 = performance.now();
  const res = await sql.unsafe(stmt);
  const ms = performance.now() - t0;
  const walBytes = Number((await wal(sql)) - w0);
  console.log(
    `- ${label}: ${ms.toFixed(1)} ms, WAL ${fmtBytes(walBytes)}${res.count ? `, ${fmtInt(res.count)} linhas` : ''}`,
  );
  return { label, ms, walBytes, rows: res.count ?? 0 };
}

async function relInfo(sql: Sql, rel: string) {
  const [r] = await sql.unsafe<
    {
      total: string;
      heap: string;
      live: string;
      dead: string;
      free_pct: number;
      dead_pct: number;
    }[]
  >(
    `SELECT pg_total_relation_size($1::regclass) AS total, pg_relation_size($1::regclass) AS heap,
            s.n_live_tup AS live, s.n_dead_tup AS dead, t.free_percent AS free_pct,
            t.dead_tuple_percent AS dead_pct
     FROM pg_stat_user_tables s, pgstattuple($1::regclass) t
     WHERE s.relid = $1::regclass`,
    [rel],
  );
  return {
    total: Number(r!.total),
    heap: Number(r!.heap),
    live: Number(r!.live),
    dead: Number(r!.dead),
    freePct: r!.free_pct,
    deadPct: r!.dead_pct,
  };
}

const show = (label: string, i: Awaited<ReturnType<typeof relInfo>>) =>
  console.log(
    `  ${label}: total ${fmtBytes(i.total)} (heap ${fmtBytes(i.heap)}), vivas ${fmtInt(i.live)}, mortas ${fmtInt(i.dead)}, ` +
      `livre ${i.freePct.toFixed(1)} %, tuplas mortas ${i.deadPct.toFixed(1)} %`,
  );

async function main() {
  const sql = await benchSql({ max: 2, params: { application_name: 'bench-retention' } });
  try {
    await readMeta(sql);
    await sql`CREATE EXTENSION IF NOT EXISTS pgstattuple`;
    // A flat é recriada aqui (cópia da bruta, PK + (link_id, occurred_at), os mesmos índices da
    // particionada), porque o DELETE a deixa sem o mês e inchada.
    console.log('- recriando clicks_flat a partir da clicks…');
    await sql`DROP TABLE IF EXISTS clicks_flat`;
    await sql`CREATE TABLE clicks_flat (LIKE clicks INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`;
    await sql`INSERT INTO clicks_flat SELECT * FROM clicks`;
    await sql`ALTER TABLE clicks_flat ADD CONSTRAINT clicks_flat_pkey PRIMARY KEY (occurred_at, event_id)`;
    await sql`CREATE INDEX clicks_flat_link_time_idx ON clicks_flat (link_id, occurred_at)`;
    await sql`VACUUM (ANALYZE, PARALLEL 0) clicks_flat`;
    const [oldest] = await sql<{ name: string; lo: string; hi: string }[]>`
      SELECT c.relname AS name,
             (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM \\(''([^'']+)''\\)'))[1] AS lo,
             (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \\(''([^'']+)''\\)'))[1] AS hi
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'clicks'::regclass AND c.relname ~ '^clicks_p[0-9]{4}_[0-9]{2}$'
      ORDER BY c.relname LIMIT 1`;
    const { lo, hi } = oldest!;
    const [second] = await sql<{ hi: string }[]>`
      SELECT to_char((${hi}::timestamptz + interval '1 month') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS+00') AS hi`;
    console.log(`Mês mais antigo: ${oldest!.name} [${lo}, ${hi})`);

    // 1) Tabela monolítica: DELETE do mês.
    console.log('\nDELETE na clicks_flat (toda a bruta, PK + (link_id, occurred_at)):');
    await sql`CHECKPOINT`;
    const before = await relInfo(sql, 'clicks_flat');
    show('antes', before);
    const del = await timed(
      sql,
      'DELETE … WHERE occurred_at < fim do mês',
      `DELETE FROM clicks_flat WHERE occurred_at < '${hi}'`,
    );
    const afterDel = await relInfo(sql, 'clicks_flat');
    show('depois do DELETE', afterDel);
    const vac = await timed(sql, 'VACUUM', 'VACUUM (PARALLEL 0) clicks_flat');
    const afterVac = await relInfo(sql, 'clicks_flat');
    show('depois do VACUUM', afterVac);
    const full = await timed(
      sql,
      'VACUUM FULL (ACCESS EXCLUSIVE: bloqueia leitura e escrita)',
      'VACUUM FULL clicks_flat',
    );
    const afterFull = await relInfo(sql, 'clicks_flat');
    show('depois do VACUUM FULL', afterFull);

    // 2) Particionada: DETACH + DROP do mesmo mês.
    console.log('\nDETACH + DROP numa particionada com os mesmos dados:');
    await sql`DROP TABLE IF EXISTS ret_clicks`;
    await sql`CREATE TABLE ret_clicks (LIKE clicks INCLUDING DEFAULTS INCLUDING CONSTRAINTS) PARTITION BY RANGE (occurred_at)`;
    await sql`SELECT ensure_monthly_partitions('ret_clicks', 'occurred_at', ${lo}::date, ${hi}::date)`;
    await sql`ALTER TABLE ret_clicks ADD CONSTRAINT ret_clicks_pkey PRIMARY KEY (occurred_at, event_id)`;
    await sql`CREATE INDEX ret_clicks_link_time_idx ON ret_clicks (link_id, occurred_at)`;
    await sql.unsafe(
      `INSERT INTO ret_clicks SELECT * FROM clicks WHERE occurred_at >= '${lo}' AND occurred_at < '${second!.hi}'`,
    );
    await sql`VACUUM (ANALYZE, PARALLEL 0) ret_clicks`;
    const part = oldest!.name.replace(/^clicks_/, 'ret_clicks_');
    const [pBefore] = await sql.unsafe<{ total: string; n: string }[]>(
      `SELECT pg_total_relation_size('${part}') AS total, (SELECT count(*) FROM ${part}) AS n`,
    );
    console.log(
      `  partição ${part}: ${fmtInt(Number(pBefore!.n))} linhas, ${fmtBytes(Number(pBefore!.total))}`,
    );
    await sql`CHECKPOINT`;
    const detach = await timed(
      sql,
      'DETACH PARTITION … CONCURRENTLY',
      `ALTER TABLE ret_clicks DETACH PARTITION ${part} CONCURRENTLY`,
    );
    const drop = await timed(sql, 'DROP TABLE da partição solta', `DROP TABLE ${part}`);
    await sql`DROP TABLE ret_clicks`;

    // 3) A função que já existe para click_visitors.
    console.log('\nclick_visitors: drop_old_visitor_partitions(90) (migração 0002):');
    const [cvBefore] = await sql<{ b: string }[]>`
      SELECT coalesce(sum(pg_total_relation_size(inhrelid)), 0) AS b FROM pg_inherits WHERE inhparent = 'click_visitors'::regclass`;
    const visitors = await timed(
      sql,
      'drop_old_visitor_partitions(90)',
      'SELECT drop_old_visitor_partitions(90) AS dropped',
    );
    const [cvAfter] = await sql<{ b: string; n: string }[]>`
      SELECT coalesce(sum(pg_total_relation_size(inhrelid)), 0) AS b, count(*) AS n FROM pg_inherits WHERE inhparent = 'click_visitors'::regclass`;
    console.log(
      `  click_visitors: ${fmtBytes(Number(cvBefore!.b))} → ${fmtBytes(Number(cvAfter!.b))} (${cvAfter!.n} partições restantes)`,
    );

    await sql`DROP TABLE clicks_flat`;
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(
      new URL('retention.json', RESULTS),
      JSON.stringify(
        {
          month: { name: oldest!.name, lo, hi },
          delete: { del, vac, full, before, afterDel, afterVac, afterFull },
          partition: { rows: Number(pBefore!.n), bytes: Number(pBefore!.total), detach, drop },
          visitors: { before: Number(cvBefore!.b), after: Number(cvAfter!.b), visitors },
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
