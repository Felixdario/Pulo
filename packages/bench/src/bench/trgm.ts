/**
 * `corepack pnpm bench:trgm [--runs=5]`
 *
 * A busca `q` de `GET /v1/links` (`listLinks` em packages/db/src/link-queries.ts):
 * `user_id = ? AND deleted_at IS NULL AND (title ILIKE ? OR slug ILIKE ? OR destination ILIKE ?)
 * ORDER BY created_at DESC, id DESC LIMIT 21`. Mede o ILIKE de hoje contra três índices GIN
 * `gin_trgm_ops` (um por coluna, para o OR virar BitmapOr sem mudar a consulta), com 2.000 links
 * (os do seed) e com 200.000 (gerados só aqui, num schema à parte), para termos raros, médios,
 * comuns e curtos (< 3 caracteres, que o trigrama não indexa).
 *
 * A consulta medida é a que o `listLinks` real gera: o bench chama a função e captura o SQL e os
 * parâmetros pelo `debug` do postgres.js, e depois roda `EXPLAIN (ANALYZE, BUFFERS)` dela com
 * `search_path` apontando para o schema do tamanho medido.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { listLinks, schema } from '@encurtador/db';
import { resolveBenchUrls } from '@encurtador/db/testing';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { benchSql, fmtBytes, readMeta } from '../bench-db';
import { explain, median, medianRun, type PlanStats } from '../explain';
import { generateLinks } from '../links';

const RESULTS = new URL('../../results/', import.meta.url);

const TERMS: { id: string; q: string }[] = [
  { id: 'raro', q: 'xpto-48213' },
  { id: 'médio', q: 'bicicleta' },
  { id: 'comum', q: 'exemplo' },
  { id: 'curto', q: '4k' },
];

const TRGM = (s: string) => [
  `CREATE INDEX IF NOT EXISTS links_title_trgm ON ${s}.links USING gin (title gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS links_slug_trgm ON ${s}.links USING gin (slug gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS links_destination_trgm ON ${s}.links USING gin (destination gin_trgm_ops)`,
];

async function main() {
  const runs = Number(/--runs=(\d+)/.exec(process.argv.join(' '))?.[1] ?? 5);
  const sql = await benchSql({ max: 2, params: { application_name: 'bench-trgm' } });
  const meta = await readMeta(sql);
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

  // 2.000: cópia dos links do seed. 200.000: gerados com o mesmo gerador (só no bench).
  const sizes = [
    { schema: 'trgm_2k', links: 2_000 },
    { schema: 'trgm_200k', links: 200_000 },
  ];
  for (const s of sizes) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${s.schema} CASCADE`);
    await sql.unsafe(`CREATE SCHEMA ${s.schema}`);
    await sql.unsafe(`CREATE TABLE ${s.schema}.links (LIKE public.links INCLUDING ALL)`);
    if (s.links === 2_000) {
      await sql.unsafe(
        `INSERT INTO ${s.schema}.links OVERRIDING SYSTEM VALUE SELECT * FROM public.links`,
      );
    } else {
      const gen = generateLinks({
        links: s.links,
        users: 20,
        seed: 7,
        startMs: meta.startMs,
        endMs: meta.endMs,
        slugOffset: 10_000_000,
      });
      // Um termo raro de verdade: 3 links em 200 mil.
      for (const i of [11, 90_001, 150_007]) gen[i]!.destination += '&ref=xpto-48213';
      for (let i = 0; i < gen.length; i += 10_000) {
        const part = gen.slice(i, i + 10_000);
        await sql.unsafe(
          `INSERT INTO ${s.schema}.links (user_id, slug, destination, title, status, created_at, updated_at, expires_at)
           SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[],
                                $6::timestamptz[], $6::timestamptz[], $7::timestamptz[])`,
          [
            part.map((l) => l.userId),
            part.map((l) => l.slug),
            part.map((l) => l.destination),
            part.map((l) => l.title),
            part.map((l) => l.status),
            part.map((l) => l.createdAt.toISOString()),
            part.map((l) => l.expiresAt?.toISOString() ?? null),
          ] as never[],
        );
      }
    }
    const t0 = performance.now();
    for (const ddl of TRGM(s.schema)) await sql.unsafe(ddl);
    const buildMs = performance.now() - t0;
    await sql.unsafe(`VACUUM (ANALYZE) ${s.schema}.links`);
    const [sz] = await sql.unsafe<{ heap: string; trgm: string }[]>(
      `SELECT pg_relation_size('${s.schema}.links') AS heap,
              pg_relation_size('${s.schema}.links_title_trgm') + pg_relation_size('${s.schema}.links_slug_trgm')
              + pg_relation_size('${s.schema}.links_destination_trgm') AS trgm`,
    );
    console.log(
      `${s.schema}: ${s.links} links, heap ${fmtBytes(Number(sz!.heap))}, 3 GIN trigrama ${fmtBytes(Number(sz!.trgm))} (${(buildMs / 1000).toFixed(1)} s para criar)`,
    );
    Object.assign(s, { heapBytes: Number(sz!.heap), trgmBytes: Number(sz!.trgm), buildMs });
  }

  const { benchUrl } = resolveBenchUrls();
  const results: {
    size: string;
    term: string;
    variant: string;
    matches: number;
    p50: number;
    median: Omit<PlanStats, 'text'>;
  }[] = [];
  const plans: string[] = [];
  for (const s of sizes) {
    let captured: { query: string; params: unknown[] } | null = null;
    const client = postgres(benchUrl, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: `${s.schema}, public` },
      debug: (_c, query, params) => {
        captured = { query, params };
      },
    });
    const db = drizzle(client, { schema });
    const [top] = await client.unsafe<{ user_id: string; n: string }[]>(
      `SELECT user_id, count(*) AS n FROM links GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
    );
    const userId = Number(top!.user_id);
    for (const t of TERMS) {
      const page = await listLinks(db, {
        userId,
        sort: 'created_at',
        dir: 'desc',
        limit: 20,
        q: t.q,
      });
      const q = captured as { query: string; params: unknown[] } | null;
      if (!q) throw new Error('consulta não capturada');
      const [m] = await client.unsafe<{ n: string }[]>(
        `SELECT count(*) AS n FROM links WHERE user_id = $1 AND deleted_at IS NULL
           AND (title ILIKE $2 OR slug ILIKE $2 OR destination ILIKE $2)`,
        [userId, `%${t.q}%`] as never[],
      );
      for (const variant of ['ilike', 'trgm'] as const) {
        const out: PlanStats[] = [];
        await client
          .begin(async (tx) => {
            if (variant === 'ilike') {
              for (const i of ['links_title_trgm', 'links_slug_trgm', 'links_destination_trgm']) {
                await tx.unsafe(`DROP INDEX ${s.schema}.${i}`);
              }
            }
            await explain(tx, { text: q.query, params: q.params });
            for (let i = 0; i < runs; i++)
              out.push(await explain(tx, { text: q.query, params: q.params }));
            throw new Error('rollback');
          })
          .catch((err: Error) => {
            if (err.message !== 'rollback') throw err;
          });
        const med = medianRun(out);
        const { text, ...rest } = med;
        results.push({
          size: s.schema,
          term: t.id,
          variant,
          matches: Number(m!.n),
          p50: median(out.map((r) => r.executionMs)),
          median: rest,
        });
        plans.push(
          `### ${s.schema} · ${t.id} ("${t.q}") · ${variant} · usuário ${userId}\n${text}\n`,
        );
        console.log(
          `${s.schema.padEnd(10)} ${t.id.padEnd(6)} ${variant.padEnd(6)} casam ${m!.n.padStart(6)}  devolveu ${page.items.length}  p50 ${median(
            out.map((r) => r.executionMs),
          )
            .toFixed(2)
            .padStart(8)} ms  hit ${med.hit} read ${med.read} linhas ${med.rowsRead}`,
        );
      }
    }
    await client.end({ timeout: 5 });
  }
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(new URL('trgm.json', RESULTS), JSON.stringify({ sizes, results }, null, 2));
  writeFileSync(new URL('trgm-plans.txt', RESULTS), plans.join('\n'));
  await sql.end({ timeout: 5 });
}

await main();
