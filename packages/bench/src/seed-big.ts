/**
 * `corepack pnpm seed:big [--clicks=5000000] [--months=12] [--links=2000] [--users=20] [--jobs=4]
 * [--seed=42] [--method=series|copy]`
 *
 * Recria do zero **só** o banco `encurtador_bench` (DROP DATABASE … WITH (FORCE) + migrações), gera
 * os cliques brutos no próprio servidor e deriva os agregados da bruta com `rebuild_aggregates`.
 * Nunca toca no `encurtador` (dev) nem no `encurtador_test`.
 *
 * Ordem (cada fase é medida e impressa):
 * 1. banco novo e migrado; usuários, links (pesos Zipf) e partições mensais;
 * 2. a PK e o índice (link_id, occurred_at) da bruta saem, para a carga não manter índice linha a
 *    linha;
 * 3. geração em `--jobs` conexões, cada uma com um pedaço contíguo de tempo;
 * 4. PK e índice de volta, uma partição por conexão (como o pg_dump faz: índice no pai com ONLY,
 *    um por partição e ATTACH), com os mesmos nomes que as migrações criam;
 * 5. `rebuild_aggregates` por mês, em paralelo;
 * 6. VACUUM (ANALYZE), que também preenche o mapa de visibilidade (index-only scan).
 */
import { recreateBenchDatabase } from '@encurtador/db/testing';
import type { Sql } from 'postgres';
import { parseSeedArgs, type SeedOptions } from './args';
import { benchSql, fmtBytes, fmtInt, fmtMs, runPool, type BenchMeta } from './bench-db';
import { copyChunk, seriesInsert, type ClickModel } from './generate';
import { generateLinks } from './links';
import { timeModel } from './profile';
import { REBUILD_AGGREGATES_SQL } from './rebuild';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function monthRanges(startMs: number, endMs: number): [string, string][] {
  const out: [string, string][] = [];
  const first = new Date(startMs);
  let cur = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  const stop = Math.floor(endMs / DAY_MS) * DAY_MS + DAY_MS; // dia seguinte ao último (inclusive o de hoje)
  while (cur < stop) {
    const d = new Date(cur);
    const next = Math.min(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), stop);
    out.push([isoDay(cur), isoDay(next)]);
    cur = next;
  }
  return out;
}

interface KeySpec {
  table: string;
  /** Nome do índice/constraint no pai, igual ao das migrações. */
  name: string;
  pk: boolean;
  cols: string;
  /** Sufixo que o Postgres dá ao índice de cada partição no ATTACH (`<partição>_<sufixo>`). */
  suffix: string;
}

/**
 * Recria PKs e índices depois da carga. Numa tabela particionada faz como o pg_dump: o índice no pai
 * com ONLY (inválido), um por partição em paralelo e ATTACH, que o valida.
 */
async function addKeys(sql: Sql, jobs: number, specs: readonly KeySpec[]) {
  const tasks: string[] = [];
  const attach: string[] = [];
  for (const k of specs) {
    const [rel] = await sql<
      { kind: string }[]
    >`SELECT relkind AS kind FROM pg_class WHERE oid = ${k.table}::regclass`;
    const ddl = (t: string, name: string, only: boolean) =>
      k.pk
        ? `ALTER TABLE ${only ? 'ONLY ' : ''}"${t}" ADD CONSTRAINT "${name}" PRIMARY KEY (${k.cols})`
        : `CREATE INDEX "${name}" ON ${only ? 'ONLY ' : ''}"${t}" (${k.cols})`;
    if (rel?.kind !== 'p') {
      tasks.push(ddl(k.table, k.name, false));
      continue;
    }
    await sql.unsafe(ddl(k.table, k.name, true));
    const parts = await sql<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = ${k.table}::regclass AND c.relkind = 'r' ORDER BY 1`;
    for (const p of parts) {
      tasks.push(ddl(p.name, `${p.name}_${k.suffix}`, true));
      attach.push(`ALTER INDEX "${k.name}" ATTACH PARTITION "${p.name}_${k.suffix}"`);
    }
  }
  // As maiores primeiro (os nomes das partições mais recentes vêm por último e são as maiores).
  tasks.reverse();
  await runPool(sql, jobs, tasks, async (conn, ddl) => {
    await conn.unsafe(ddl);
  });
  for (const a of attach) await sql.unsafe(a);
}

async function phase<T>(timings: Record<string, number>, name: string, fn: () => Promise<T>) {
  const t0 = performance.now();
  process.stdout.write(`- ${name}… `);
  const r = await fn();
  timings[name] = performance.now() - t0;
  process.stdout.write(`${fmtMs(timings[name])}\n`);
  return r;
}

async function seedLinks(sql: Sql, o: SeedOptions, startMs: number, endMs: number) {
  await sql`
    INSERT INTO users (email, password_hash)
    SELECT 'bench-' || i || '@bench.invalid', 'sem-login'
    FROM generate_series(1, ${o.users}::int) AS i`;
  const links = generateLinks({ ...o, startMs, endMs });
  const ids: number[] = [];
  for (let i = 0; i < links.length; i += 5000) {
    const part = links.slice(i, i + 5000);
    const rows = await sql<{ id: string }[]>`
      INSERT INTO links (user_id, slug, destination, title, status, created_at, updated_at, expires_at)
      SELECT * FROM unnest(
        ${part.map((l) => l.userId)}::bigint[], ${part.map((l) => l.slug)}::text[],
        ${part.map((l) => l.destination)}::text[], ${part.map((l) => l.title)}::text[],
        ${part.map((l) => l.status)}::text[],
        ${part.map((l) => l.createdAt.toISOString())}::timestamptz[],
        ${part.map((l) => l.createdAt.toISOString())}::timestamptz[],
        ${part.map((l) => l.expiresAt?.toISOString() ?? null)}::timestamptz[])
      RETURNING id`;
    ids.push(...rows.map((r) => Number(r.id)));
  }
  await sql`CREATE SCHEMA bench`;
  await sql`CREATE TABLE bench.link_model (link_id bigint PRIMARY KEY, rank int NOT NULL, weight float8 NOT NULL)`;
  await sql`
    INSERT INTO bench.link_model
    SELECT * FROM unnest(${ids}::bigint[], ${links.map((l) => l.rank)}::int[],
                         ${links.map((l) => l.weight)}::float8[])`;
  return links.map((l, i) => ({ ...l, id: ids[i]! }));
}

async function main() {
  const o = parseSeedArgs(process.argv.slice(2));
  const timings: Record<string, number> = {};
  const total0 = performance.now();
  const endMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const s = new Date(endMs);
  s.setUTCMonth(s.getUTCMonth() - o.months);
  const startMs = s.getTime();
  console.log(
    `seed:big → encurtador_bench: ${fmtInt(o.clicks)} cliques, ${o.months} meses ` +
      `(${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}), ${fmtInt(o.links)} links, ` +
      `${o.users} usuários, ${o.jobs} conexões, método ${o.method}, semente ${o.seed}`,
  );

  await phase(timings, 'recriar e migrar o banco', () => recreateBenchDatabase());
  const sql = await benchSql({
    max: o.jobs + 1,
    params: {
      work_mem: '256MB',
      maintenance_work_mem: '512MB',
      synchronous_commit: 'off',
      application_name: 'seed-big',
    },
  });
  try {
    const links = await phase(timings, 'usuários, links e partições', async () => {
      const l = await seedLinks(sql, o, startMs, endMs);
      const firstMonth = isoDay(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1));
      const nextMonth = new Date(endMs);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      await sql`SELECT ensure_click_partitions(${firstMonth}::date, ${isoDay(nextMonth.getTime())}::date)`;
      await sql.unsafe(REBUILD_AGGREGATES_SQL);
      return l;
    });

    if (!o.keepIndexes) {
      await phase(timings, 'tirar PK e índice da bruta', async () => {
        await sql`DROP INDEX clicks_link_time_idx`;
        await sql`ALTER TABLE clicks DROP CONSTRAINT clicks_pkey`;
      });
    }

    const sorted = [...links].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let acc = 0;
    const model: ClickModel = {
      clicks: o.clicks,
      seed: o.seed,
      time: timeModel(startMs, endMs),
      linkIds: sorted.map((l) => l.id),
      linkCreatedMs: sorted.map((l) => l.createdAt.getTime()),
      linkCumWeight: sorted.map((l) => (acc += l.weight)),
      visitorPool: Math.max(500, Math.round((o.clicks / ((endMs - startMs) / DAY_MS)) * 0.9)),
    };

    // Um pedaço de i por mês do calendário: cada partição é escrita por uma conexão só, do começo ao
    // fim do mês, em ordem de tempo (com dois pedaços no mesmo mês as páginas se intercalariam e a
    // correlação física de occurred_at cairia). O clique i cai no quantil (i − U)/N, então o limite
    // do mês é ⌊N × CDF(início do mês)⌋; no máximo um clique por fronteira vaza para o mês vizinho.
    const chunks: [number, number][] = [];
    let prev = 0;
    for (const [, to] of monthRanges(startMs, endMs)) {
      const toMs = Math.min(Date.parse(`${to}T00:00:00Z`), endMs);
      const k = Math.round((toMs - startMs) / HOUR_MS);
      const cdf = k >= model.time.cumulative.length ? 1 : (model.time.cumulative[k - 1] ?? 0);
      const hi = Math.min(o.clicks, Math.floor(o.clicks * cdf));
      if (hi > prev) chunks.push([prev + 1, hi]);
      prev = hi;
    }
    if (prev < o.clicks) chunks.push([prev + 1, o.clicks]);
    // Os meses maiores primeiro: a fila termina mais equilibrada.
    chunks.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
    await phase(timings, `gerar ${fmtInt(o.clicks)} cliques (${o.method})`, () =>
      runPool(sql, o.jobs, chunks, async (conn, [lo, hi], c) => {
        if (o.method === 'copy') {
          await copyChunk(conn, model, lo, hi, c);
        } else {
          const seed = ((o.seed * 7919 + c * 104_729) % 1_999_999) / 1_000_000 - 0.999_999;
          await conn`SELECT setseed(${seed})`;
          const q = seriesInsert(model, lo, hi);
          await conn.unsafe(q.text, q.params);
        }
      }),
    );

    if (!o.keepIndexes) {
      await phase(timings, 'PK e índice (link_id, occurred_at) por partição', () =>
        addKeys(sql, o.jobs, [
          {
            table: 'clicks',
            name: 'clicks_pkey',
            pk: true,
            cols: 'occurred_at, event_id',
            suffix: 'pkey',
          },
          {
            table: 'clicks',
            name: 'clicks_link_time_idx',
            pk: false,
            cols: 'link_id, occurred_at',
            suffix: 'link_id_occurred_at_idx',
          },
        ]),
      );
    }

    // Os agregados carregam com a PK no lugar. Medido com 5 M: tirar as PKs e recriá-las depois
    // deu 112 s de rebuild + 82 s de PK, contra 188 s com elas; sem ganho, fica o mais simples.
    const months = monthRanges(startMs, endMs);
    await phase(timings, `rebuild_aggregates (${months.length} meses)`, () =>
      runPool(sql, o.jobs, months, async (conn, [from, to]) => {
        await conn`SELECT * FROM rebuild_aggregates(${from}::date, ${to}::date)`;
      }),
    );

    await phase(timings, 'VACUUM (ANALYZE)', () =>
      runPool(
        sql,
        o.jobs,
        [
          'clicks',
          'click_visitors',
          'clicks_hourly',
          'clicks_daily',
          'clicks_daily_dim',
          'clicks_daily_preview',
          'links',
          'users',
          'bench.link_model',
        ],
        async (conn, table) => {
          await conn.unsafe(`VACUUM (ANALYZE, PARALLEL 0) ${table}`);
        },
      ),
    );

    timings.total = performance.now() - total0;
    const meta = await writeMeta(sql, o, startMs, endMs, timings);
    await report(sql, meta, timings);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function writeMeta(
  sql: Sql,
  o: SeedOptions,
  startMs: number,
  endMs: number,
  timings: Record<string, number>,
): Promise<BenchMeta> {
  const [hot] = await sql<{ id: string; user_id: string }[]>`
    SELECT id, user_id FROM links ORDER BY click_count DESC, id LIMIT 1`;
  // Frio: ~200 cliques humanos no ano e criado há mais de 90 dias (tem série para mostrar).
  const [cold] = await sql<{ id: string }[]>`
    SELECT id FROM links
    WHERE click_count > 0 AND created_at < ${new Date(endMs - 90 * DAY_MS)}
    ORDER BY abs(click_count - 200), id LIMIT 1`;
  const zero = await sql<{ id: string }[]>`
    SELECT id FROM links l
    WHERE NOT EXISTS (SELECT 1 FROM clicks_daily d WHERE d.link_id = l.id)
    ORDER BY id`;
  const meta: BenchMeta = {
    options: { ...o },
    startMs,
    endMs,
    hotLink: Number(hot!.id),
    coldLink: Number(cold?.id ?? hot!.id),
    zeroLinks: zero.map((z) => Number(z.id)),
    hotUser: Number(hot!.user_id),
    timings,
  };
  await sql`CREATE TABLE bench.meta (k text PRIMARY KEY, v jsonb NOT NULL)`;
  await sql`INSERT INTO bench.meta VALUES ('seed', ${sql.json(meta as never)})`;
  return meta;
}

async function report(sql: Sql, meta: BenchMeta, timings: Record<string, number>) {
  console.log(`\nTempo total: ${fmtMs(timings.total!)}`);
  const [kinds] = await sql<{ total: string; human: string; bot: string; preview: string }[]>`
    SELECT count(*) AS total, count(*) FILTER (WHERE kind = 'human') AS human,
           count(*) FILTER (WHERE kind = 'bot') AS bot,
           count(*) FILTER (WHERE kind = 'preview') AS preview
    FROM clicks`;
  const t = Number(kinds!.total);
  const pct = (x: string) => `${((Number(x) / t) * 100).toFixed(1).replace('.', ',')} %`;
  console.log(
    `Bruta: ${fmtInt(t)} cliques — humanos ${pct(kinds!.human)}, robôs ${pct(kinds!.bot)}, prévias ${pct(kinds!.preview)}`,
  );
  const hist = await sql<{ bucket: string; links: string; clicks: string }[]>`
    WITH per AS (
      SELECT l.id, coalesce(sum(d.total), 0) AS n
      FROM links l LEFT JOIN clicks_daily d ON d.link_id = l.id GROUP BY l.id
    )
    SELECT CASE WHEN n = 0 THEN '0' WHEN n < 10 THEN '1–9' WHEN n < 100 THEN '10–99'
                WHEN n < 1000 THEN '100–999' WHEN n < 10000 THEN '1 mil–9.999'
                WHEN n < 100000 THEN '10 mil–99.999' ELSE '≥ 100 mil' END AS bucket,
           count(*) AS links, sum(n) AS clicks, min(n) AS lo
    FROM per GROUP BY 1 ORDER BY min(n)`;
  console.log('\nCliques por link (todos os tipos):');
  console.log('| faixa | links | cliques |\n| - | -: | -: |');
  for (const h of hist) console.log(`| ${h.bucket} | ${fmtInt(+h.links)} | ${fmtInt(+h.clicks)} |`);
  const top = await sql<{ id: string; n: string }[]>`
    SELECT link_id AS id, sum(total) AS n FROM clicks_daily GROUP BY 1 ORDER BY 2 DESC LIMIT 5`;
  console.log(`Top 5: ${top.map((r) => `#${r.id} = ${fmtInt(+r.n)}`).join(', ')}`);
  console.log(
    `Link quente #${meta.hotLink} (usuário ${meta.hotUser}), link frio #${meta.coldLink}, ` +
      `${meta.zeroLinks.length} links com 0 cliques`,
  );

  const sizes = await sql<{ name: string; parent: string | null; rows: string; bytes: string }[]>`
    WITH rels AS (
      SELECT c.oid, c.relname AS name, NULL::text AS parent
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      UNION ALL
      SELECT c.oid, c.relname, p.relname
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
      WHERE c.relkind IN ('r', 'p')
    )
    SELECT name, parent, 0::bigint AS rows,
           CASE WHEN (SELECT relkind FROM pg_class WHERE oid = rels.oid) = 'p'
                THEN (SELECT sum(pg_total_relation_size(inhrelid)) FROM pg_inherits WHERE inhparent = rels.oid)
                ELSE pg_total_relation_size(oid) END AS bytes
    FROM rels ORDER BY coalesce(parent, name), parent NULLS FIRST, name`;
  console.log('\nTamanho (linhas exatas e pg_total_relation_size, com índices e TOAST):');
  console.log('| tabela / partição | linhas | tamanho |\n| - | -: | -: |');
  for (const r of sizes) {
    const [c] = await sql.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM "${r.name}"`);
    console.log(
      `| ${r.parent ? `↳ ${r.name}` : `**${r.name}**`} | ${fmtInt(Number(c!.n))} | ${fmtBytes(Number(r.bytes))} |`,
    );
  }
  const [db] = await sql<{ b: string }[]>`SELECT pg_database_size(current_database()) AS b`;
  console.log(`\nBanco encurtador_bench: ${fmtBytes(Number(db!.b))}`);
  console.log('\nFases:');
  for (const [k, v] of Object.entries(timings)) console.log(`  ${k}: ${fmtMs(v)}`);
}

await main();
