/**
 * `corepack pnpm bench:analytics [--runs=5] [--no-cold] [--only=ingenua,a,…]`
 *
 * Antes × depois das consultas do dashboard sobre o `encurtador_bench` (rode `seed:big` antes):
 *
 * - **ingenua**: `clicks_flat`, cópia não particionada da bruta, só com a PK; COUNT … GROUP BY;
 * - **a**: + btree (link_id, occurred_at);
 * - **b**: a `clicks` real, particionada por mês (partition pruning) com o índice da migração;
 * - **c-brin / c-btree / c-seq**: a flat só com BRIN(occurred_at), só com btree(occurred_at), sem
 *   índice nenhum;
 * - **d**: particionada com (link_id, occurred_at) INCLUDE (kind, visitor, country);
 * - **b-brin**: particionada com BRIN no lugar da PK (só para a varredura de um dia inteiro);
 * - **agregados**: as consultas reais da API (`packages/db/src/stats.ts`).
 *
 * Os índices de todas as variantes existem ao mesmo tempo; cada variante roda numa transação que
 * apaga (DROP) os que ela não deve ver e termina em ROLLBACK, então o planejador só enxerga a
 * estrutura medida e nada é reconstruído entre uma e outra.
 *
 * Quente: 1 execução de aquecimento + `--runs` medidas; a tabela usa a execução mediana (tempo,
 * buffers e linhas lidas da mesma execução, que é o plano gravado). Frio: o container do Postgres é
 * parado, o page cache da VM do Docker é esvaziado e o Postgres sobe de novo antes de **cada**
 * consulta (`coldRestart`), com `track_io_timing` ligado.
 *
 * Resultado: `packages/bench/results/analytics.json` e `analytics-plans.txt` (planos completos).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  accountSeriesQuery,
  accountTopLinksQuery,
  dailySeriesQuery,
  hourlySeriesQuery,
  topDimensionQuery,
  utcDate,
} from '@encurtador/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { benchSql, fmtBytes, readMeta, type BenchMeta } from '../bench-db';
import { coldRestart, explain, median, medianRun, type PlanStats, type Query } from '../explain';

const DAY_MS = 86_400_000;
const RESULTS = new URL('../../results/', import.meta.url);

type QueryId = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q5b' | 'Q6' | 'Q1tz';

export const QUERY_LABELS: Record<QueryId, string> = {
  Q1: 'série diária 30 d, link quente',
  Q2: 'série diária 30 d, link frio',
  Q3: 'top 10 países 90 d, link quente',
  Q4: 'únicos × totais por dia 30 d, link quente',
  Q5: 'visão da conta: série diária 12 meses',
  Q5b: 'visão da conta: top 10 links 12 meses',
  Q6: 'um dia inteiro, todos os links (backfill/consistência)',
  Q1tz: 'série diária 30 d, link quente, America/Sao_Paulo',
};

interface Variant {
  id: string;
  label: string;
  table: 'clicks_flat' | 'clicks';
  /** DDL rodado dentro da transação (e desfeito no ROLLBACK). */
  hide: string[];
  queries: QueryId[];
}

const FLAT_IDX = {
  pkey: 'ALTER TABLE clicks_flat DROP CONSTRAINT clicks_flat_pkey',
  linkTime: 'DROP INDEX clicks_flat_link_time_idx',
  time: 'DROP INDEX clicks_flat_time_idx',
  brin: 'DROP INDEX clicks_flat_time_brin',
};
const PART_IDX = {
  pkey: 'ALTER TABLE clicks DROP CONSTRAINT clicks_pkey',
  linkTime: 'DROP INDEX clicks_link_time_idx',
  cover: 'DROP INDEX clicks_cover_idx',
  brin: 'DROP INDEX clicks_time_brin',
};

const RAW: QueryId[] = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'];

const VARIANTS: Variant[] = [
  {
    id: 'ingenua',
    label: 'flat, só PK (occurred_at, event_id)',
    table: 'clicks_flat',
    hide: [FLAT_IDX.linkTime, FLAT_IDX.time, FLAT_IDX.brin],
    queries: RAW,
  },
  {
    id: 'a',
    label: 'flat + btree (link_id, occurred_at)',
    table: 'clicks_flat',
    hide: [FLAT_IDX.time, FLAT_IDX.brin],
    queries: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
  },
  {
    id: 'b',
    label: 'particionada por mês + (link_id, occurred_at) [schema real]',
    table: 'clicks',
    hide: [PART_IDX.cover, PART_IDX.brin],
    queries: RAW,
  },
  {
    id: 'c-brin',
    label: 'flat, só BRIN (occurred_at)',
    table: 'clicks_flat',
    hide: [FLAT_IDX.pkey, FLAT_IDX.linkTime, FLAT_IDX.time],
    queries: RAW,
  },
  {
    id: 'c-btree',
    label: 'flat, só btree (occurred_at)',
    table: 'clicks_flat',
    hide: [FLAT_IDX.pkey, FLAT_IDX.linkTime, FLAT_IDX.brin],
    queries: RAW,
  },
  {
    id: 'c-seq',
    label: 'flat sem índice nenhum',
    table: 'clicks_flat',
    hide: [FLAT_IDX.pkey, FLAT_IDX.linkTime, FLAT_IDX.time, FLAT_IDX.brin],
    queries: ['Q1', 'Q6'],
  },
  {
    id: 'd',
    label: 'particionada + (link_id, occurred_at) INCLUDE (kind, visitor, country)',
    table: 'clicks',
    hide: [PART_IDX.linkTime, PART_IDX.brin],
    queries: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
  },
  {
    id: 'b-brin',
    label: 'particionada, BRIN (occurred_at) no lugar da PK',
    table: 'clicks',
    hide: [PART_IDX.pkey, PART_IDX.cover],
    queries: ['Q6'],
  },
  {
    id: 'agregados',
    label: 'agregados (consultas reais da API, stats.ts)',
    table: 'clicks',
    hide: [],
    queries: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q5b', 'Q1tz'],
  },
];

interface Windows {
  /** Dias UTC [lo, hi) que a API usa para "últimos 30/90/365 dias" até `endMs`. */
  d30: [string, string];
  d90: [string, string];
  d365: [string, string];
  day: [string, string];
}

function windows(meta: BenchMeta): Windows {
  const end = meta.endMs;
  const hi = utcDate(new Date(end - 1 + DAY_MS));
  const span = (days: number): [string, string] => [utcDate(new Date(end - days * DAY_MS)), hi];
  const mid = end - 45 * DAY_MS;
  return {
    d30: span(30),
    d90: span(90),
    d365: span(365),
    day: [utcDate(new Date(mid)), utcDate(new Date(mid + DAY_MS))],
  };
}

const ts = (day: string) => `'${day} 00:00:00+00'`;

/** Consultas ingênuas: COUNT … GROUP BY direto na bruta. */
function rawQuery(id: QueryId, table: string, meta: BenchMeta, w: Windows): Query {
  const series = (link: number, [lo, hi]: [string, string]) => `
SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, count(*) AS total,
       count(*) FILTER (WHERE kind = 'human') AS humans,
       count(*) FILTER (WHERE kind = 'bot') AS bots,
       count(*) FILTER (WHERE kind = 'preview') AS previews
FROM ${table}
WHERE link_id = ${link} AND occurred_at >= ${ts(lo)} AND occurred_at < ${ts(hi)}
GROUP BY 1 ORDER BY 1`;
  switch (id) {
    case 'Q1':
      return { text: series(meta.hotLink, w.d30) };
    case 'Q2':
      return { text: series(meta.coldLink, w.d30) };
    case 'Q3':
      return {
        text: `
SELECT coalesce(country, '(desconhecido)') AS value, count(*) AS n
FROM ${table}
WHERE link_id = ${meta.hotLink} AND kind = 'human'
  AND occurred_at >= ${ts(w.d90[0])} AND occurred_at < ${ts(w.d90[1])}
GROUP BY 1 ORDER BY n DESC, value LIMIT 10`,
      };
    case 'Q4':
      return {
        text: `
SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, count(*) AS total,
       count(DISTINCT visitor) FILTER (WHERE kind = 'human') AS uniques
FROM ${table}
WHERE link_id = ${meta.hotLink} AND occurred_at >= ${ts(w.d30[0])} AND occurred_at < ${ts(w.d30[1])}
GROUP BY 1 ORDER BY 1`,
      };
    case 'Q5':
      return {
        text: `
SELECT (c.occurred_at AT TIME ZONE 'UTC')::date AS day, count(*) AS total,
       count(*) FILTER (WHERE c.kind = 'human') AS humans
FROM links l JOIN ${table} c ON c.link_id = l.id
WHERE l.user_id = ${meta.hotUser} AND l.deleted_at IS NULL
  AND c.occurred_at >= ${ts(w.d365[0])} AND c.occurred_at < ${ts(w.d365[1])}
GROUP BY 1 ORDER BY 1`,
      };
    case 'Q6':
      return {
        text: `
SELECT link_id, count(*) AS total, count(*) FILTER (WHERE kind = 'human') AS humans
FROM ${table}
WHERE occurred_at >= ${ts(w.day[0])} AND occurred_at < ${ts(w.day[1])}
GROUP BY link_id`,
      };
    default:
      throw new Error(`sem versão ingênua: ${id}`);
  }
}

const dialect = new PgDialect();
const fromDrizzle = (q: SQL): Query => {
  const { sql, params } = dialect.sqlToQuery(q);
  return { text: sql, params };
};

/** As consultas que a API roda de verdade (stats.ts), com os mesmos parâmetros. */
function apiQuery(id: QueryId, meta: BenchMeta, w: Windows): Query {
  const from = new Date(meta.endMs - 30 * DAY_MS);
  const to = new Date(meta.endMs);
  switch (id) {
    case 'Q1':
    case 'Q4':
      return fromDrizzle(
        dailySeriesQuery({ linkId: meta.hotLink, granularity: 'day', from, to, tz: 'UTC' }),
      );
    case 'Q2':
      return fromDrizzle(
        dailySeriesQuery({ linkId: meta.coldLink, granularity: 'day', from, to, tz: 'UTC' }),
      );
    case 'Q1tz':
      return fromDrizzle(
        hourlySeriesQuery({
          linkId: meta.hotLink,
          granularity: 'day',
          from,
          to,
          tz: 'America/Sao_Paulo',
        }),
      );
    case 'Q3':
      return fromDrizzle(
        topDimensionQuery({
          linkId: meta.hotLink,
          dim: 'country',
          limit: 10,
          fromDay: w.d90[0],
          toDay: w.d90[1],
        }),
      );
    case 'Q5':
      return fromDrizzle(
        accountSeriesQuery({ userId: meta.hotUser, fromDay: w.d365[0], toDay: w.d365[1] }),
      );
    case 'Q5b':
      return fromDrizzle(
        accountTopLinksQuery({
          userId: meta.hotUser,
          fromDay: w.d365[0],
          toDay: w.d365[1],
          limit: 10,
        }),
      );
    default:
      throw new Error(`sem consulta da API: ${id}`);
  }
}

const queryFor = (v: Variant, id: QueryId, meta: BenchMeta, w: Windows) =>
  v.id === 'agregados' ? apiQuery(id, meta, w) : rawQuery(id, v.table, meta, w);

let SETTINGS: [string, string][] = [];

async function inVariant<T>(sql: Sql, v: Variant, fn: (conn: Sql) => Promise<T>): Promise<T> {
  let out!: T;
  await sql
    .begin(async (tx) => {
      await tx.unsafe(`SET LOCAL track_io_timing = on`);
      for (const [k, val] of SETTINGS) await tx.unsafe(`SET LOCAL ${k} = '${val}'`);
      for (const ddl of v.hide) await tx.unsafe(ddl);
      out = await fn(tx as unknown as Sql);
      throw new Rollback();
    })
    .catch((err) => {
      if (!(err instanceof Rollback)) throw err;
    });
  return out;
}

class Rollback extends Error {}

/** Cria a flat e os índices extras (idempotente). */
async function setup(sql: Sql) {
  const [flat] = await sql`SELECT to_regclass('clicks_flat') AS r`;
  if (!flat?.r) {
    console.log('- criando clicks_flat (cópia não particionada, na ordem física da bruta)…');
    await sql`CREATE TABLE clicks_flat (LIKE clicks INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`;
    await sql`INSERT INTO clicks_flat SELECT * FROM clicks`;
    await sql`ALTER TABLE clicks_flat ADD CONSTRAINT clicks_flat_pkey PRIMARY KEY (occurred_at, event_id)`;
    await sql`VACUUM (ANALYZE, PARALLEL 0) clicks_flat`;
  }
  const ddl = [
    'CREATE INDEX IF NOT EXISTS clicks_flat_link_time_idx ON clicks_flat (link_id, occurred_at)',
    'CREATE INDEX IF NOT EXISTS clicks_flat_time_idx ON clicks_flat (occurred_at)',
    'CREATE INDEX IF NOT EXISTS clicks_flat_time_brin ON clicks_flat USING brin (occurred_at)',
    'CREATE INDEX IF NOT EXISTS clicks_cover_idx ON clicks (link_id, occurred_at) INCLUDE (kind, visitor, country)',
    'CREATE INDEX IF NOT EXISTS clicks_time_brin ON clicks USING brin (occurred_at)',
  ];
  for (const d of ddl) {
    const t0 = performance.now();
    await sql.unsafe(d);
    const ms = performance.now() - t0;
    if (ms > 50) console.log(`- ${d.replace(/ ON .*/, '')}: ${(ms / 1000).toFixed(1)} s`);
  }
  await sql`VACUUM (ANALYZE, PARALLEL 0) clicks_flat`;
  await sql`ANALYZE clicks`;
}

interface Sizes {
  relations: { name: string; bytes: number }[];
  correlation: { table: string; column: string; correlation: number }[];
}

async function sizes(sql: Sql): Promise<Sizes> {
  const relations = await sql<{ name: string; bytes: string }[]>`
    WITH rel(name, oid) AS (
      VALUES ('clicks_flat (heap)', 'clicks_flat'::regclass),
             ('clicks_flat_pkey', 'clicks_flat_pkey'::regclass),
             ('clicks_flat_link_time_idx', 'clicks_flat_link_time_idx'::regclass),
             ('clicks_flat_time_idx', 'clicks_flat_time_idx'::regclass),
             ('clicks_flat_time_brin', 'clicks_flat_time_brin'::regclass),
             ('clicks (heap, partições)', 'clicks'::regclass),
             ('clicks_pkey', 'clicks_pkey'::regclass),
             ('clicks_link_time_idx', 'clicks_link_time_idx'::regclass),
             ('clicks_cover_idx', 'clicks_cover_idx'::regclass),
             ('clicks_time_brin', 'clicks_time_brin'::regclass),
             ('clicks_hourly (heap)', 'clicks_hourly'::regclass),
             ('clicks_hourly_pkey', 'clicks_hourly_pkey'::regclass),
             ('clicks_daily (heap)', 'clicks_daily'::regclass),
             ('clicks_daily_pkey', 'clicks_daily_pkey'::regclass),
             ('clicks_daily_dim (heap)', 'clicks_daily_dim'::regclass),
             ('clicks_daily_dim_pkey', 'clicks_daily_dim_pkey'::regclass),
             ('clicks_daily_preview (heap)', 'clicks_daily_preview'::regclass),
             ('clicks_daily_preview_pkey', 'clicks_daily_preview_pkey'::regclass)
    )
    SELECT name,
           CASE WHEN c.relkind IN ('p', 'I')
                THEN (SELECT coalesce(sum(pg_relation_size(i.inhrelid)), 0) FROM pg_inherits i WHERE i.inhparent = rel.oid)
                ELSE pg_relation_size(rel.oid) END AS bytes
    FROM rel JOIN pg_class c ON c.oid = rel.oid`;
  const correlation = await sql<{ table: string; column: string; correlation: number }[]>`
    SELECT tablename AS table, attname AS column, correlation
    FROM pg_stats
    WHERE schemaname = 'public' AND attname IN ('occurred_at', 'link_id')
      AND (tablename = 'clicks_flat' OR tablename ~ '^clicks_p[0-9]{4}_[0-9]{2}$')
    ORDER BY tablename, attname`;
  return {
    relations: relations.map((r) => ({ name: r.name, bytes: Number(r.bytes) })),
    correlation,
  };
}

export interface Measurement {
  variant: string;
  query: QueryId;
  warm: number[];
  p50: number;
  median: Omit<PlanStats, 'text'>;
  cold?: Omit<PlanStats, 'text'>;
  coldRuns?: number[];
}

function parseArgs(argv: string[]) {
  const o = {
    runs: 5,
    cold: true,
    coldRuns: 3,
    coldOnly: false,
    only: null as string[] | null,
    tag: '',
    settings: [] as [string, string][],
  };
  for (const a of argv) {
    if (a === '--no-cold') o.cold = false;
    else if (a === '--cold-only') o.coldOnly = true;
    else if (a.startsWith('--cold-runs=')) o.coldRuns = Number(a.slice(12));
    else if (a.startsWith('--tag=')) o.tag = `-${a.slice(6).replace(/[^a-z0-9_-]/gi, '')}`;
    else if (a.startsWith('--set=')) {
      // --set=random_page_cost=1.1: SET LOCAL em cada transação medida.
      const [k, v] = a.slice(6).split('=');
      if (!k || v === undefined || !/^[a-z_]+$/.test(k) || !/^[a-z0-9_.]+$/i.test(v)) {
        throw new TypeError(`--set inválido: ${a}`);
      }
      o.settings.push([k, v]);
    } else if (a.startsWith('--runs=')) o.runs = Number(a.slice(7));
    else if (a.startsWith('--only=')) o.only = a.slice(7).split(',');
    else if (a !== '--') throw new TypeError(`argumento inesperado: ${a}`);
  }
  return o;
}

const strip = (p: PlanStats): Omit<PlanStats, 'text'> => {
  const { text, ...rest } = p;
  void text;
  return rest;
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  SETTINGS = opts.settings;
  let sql = await benchSql({ max: 2, params: { application_name: 'bench-analytics' } });
  const meta = await readMeta(sql);
  const w = windows(meta);
  console.log(
    `link quente #${meta.hotLink}, frio #${meta.coldLink}, usuário #${meta.hotUser}; 30 d = [${w.d30.join(', ')}), dia = ${w.day[0]}`,
  );
  await setup(sql);
  const variants = VARIANTS.filter((v) => !opts.only || opts.only.includes(v.id));
  const results: Measurement[] = [];
  const plans: string[] = [];
  if (opts.coldOnly) {
    // Reaproveita as medições quentes da última rodada e refaz só as frias.
    const prev = JSON.parse(
      readFileSync(new URL(`analytics${opts.tag}.json`, RESULTS), 'utf8'),
    ) as { results: Measurement[] };
    results.push(...prev.results);
    const text = readFileSync(new URL(`analytics${opts.tag}-plans.txt`, RESULTS), 'utf8');
    plans.push(...text.split(/\n(?=### )/).filter((p) => !/ · FRIO/.test(p.split('\n')[0]!)));
  }

  for (const v of opts.coldOnly ? [] : variants) {
    for (const qid of v.queries) {
      const q = queryFor(v, qid, meta, w);
      const runs = await inVariant(sql, v, async (tx) => {
        await explain(tx, q); // aquecimento
        const out: PlanStats[] = [];
        for (let i = 0; i < opts.runs; i++) out.push(await explain(tx, q));
        return out;
      });
      const med = medianRun(runs);
      const m: Measurement = {
        variant: v.id,
        query: qid,
        warm: runs.map((r) => r.executionMs),
        p50: median(runs.map((r) => r.executionMs)),
        median: strip(med),
      };
      results.push(m);
      plans.push(
        `### ${v.id} · ${qid} (${QUERY_LABELS[qid]}) · quente, execução mediana de ${opts.runs}\n-- ${v.label}\n${q.text.trim()}\n${q.params?.length ? `-- params: ${JSON.stringify(q.params)}\n` : ''}\n${med.text}\n`,
      );
      console.log(
        `${v.id.padEnd(10)} ${qid.padEnd(5)} p50 ${m.p50.toFixed(2).padStart(9)} ms  hit ${String(med.hit).padStart(7)} read ${String(med.read).padStart(7)}  linhas ${med.rowsRead}`,
      );
    }
  }

  if (opts.cold) {
    for (const v of variants) {
      for (const qid of v.queries) {
        const q = queryFor(v, qid, meta, w);
        const colds: PlanStats[] = [];
        for (let i = 0; i < opts.coldRuns; i++) {
          await sql.end({ timeout: 5 });
          await coldRestart(async () => {
            sql = await benchSql({ max: 2, params: { application_name: 'bench-analytics' } });
          });
          colds.push(await inVariant(sql, v, (tx) => explain(tx, q)));
        }
        const cold = medianRun(colds);
        const m = results.find((r) => r.variant === v.id && r.query === qid);
        if (!m) continue;
        m.cold = strip(cold);
        m.coldRuns = colds.map((c) => c.executionMs);
        plans.push(
          `### ${v.id} · ${qid} · FRIO, execução mediana de ${opts.coldRuns} (cada uma depois de reiniciar o Postgres e esvaziar o page cache)\n\n${cold.text}\n`,
        );
        console.log(
          `${v.id.padEnd(10)} ${qid.padEnd(5)} frio ${cold.executionMs.toFixed(2).padStart(9)} ms  hit ${String(cold.hit).padStart(7)} read ${String(cold.read).padStart(7)}  I/O ${cold.ioReadMs.toFixed(1)} ms`,
        );
      }
    }
  }

  const sz = await sizes(sql);
  console.log('\nTamanhos (pg_relation_size; particionadas somam as partições):');
  for (const r of sz.relations) console.log(`  ${r.name.padEnd(34)} ${fmtBytes(r.bytes)}`);
  console.log('\npg_stats.correlation:');
  for (const c of sz.correlation)
    console.log(`  ${c.table.padEnd(18)} ${c.column.padEnd(12)} ${c.correlation.toFixed(4)}`);

  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    new URL(`analytics${opts.tag}.json`, RESULTS),
    JSON.stringify({ meta, windows: w, settings: opts.settings, results, sizes: sz }, null, 2),
  );
  writeFileSync(new URL(`analytics${opts.tag}-plans.txt`, RESULTS), plans.join('\n'));
  console.log(`\nresultados em ${new URL(`analytics${opts.tag}.json`, RESULTS).pathname}`);
  await sql.end({ timeout: 5 });
}

await main();
