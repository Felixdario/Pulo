/**
 * `corepack pnpm bench:write [--batches=60] [--rounds=2]`
 *
 * Custo de escrita de cada índice na bruta: roda o `insertBatch` **real** do worker
 * (`apps/worker/src/sql.ts`, a instrução única com bruta + agregados) contra o `encurtador_bench`
 * já com os 5 M de cliques, em lotes de 1.000 eventos, com conjuntos de índices diferentes em
 * `clicks`:
 *
 * - `so-pk`: só a PK (sem o `clicks_link_time_idx` da migração 0002);
 * - `atual`: PK + (link_id, occurred_at), o schema de hoje;
 * - `+brin`: atual + BRIN (occurred_at);
 * - `+btree-tempo`: atual + btree (occurred_at);
 * - `+cobrindo`: atual + (link_id, occurred_at) INCLUDE (kind, visitor, country).
 *
 * Mede eventos/s, duração do lote (p50/p95) e WAL gerado por evento, com 1 conexão (um worker) e
 * com 4 em paralelo. As rodadas alternam a ordem das variantes (ida e volta) para o ruído da máquina
 * não favorecer nenhuma. Os eventos são gravados de verdade (com agregados), então a consistência
 * agregado × bruto continua exata depois. No fim, `clicks` volta ao schema da migração.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { uuidv7 } from '@encurtador/shared';
import { insertBatch, pgArray } from '@encurtador/worker/sql';
import type { Sql } from 'postgres';
import { benchSql, fmtBytes, readMeta } from '../bench-db';
import { median } from '../explain';
import { bucket, mulberry32, PLACES, PLATFORMS, thresholds } from '../profile';

const RESULTS = new URL('../../results/', import.meta.url);

interface Variant {
  id: string;
  /** Índices extras criados antes (e apagados depois). */
  create: string[];
  /** Índices da migração que saem durante a variante (e voltam depois). */
  drop: string[];
}

const LINK_TIME = 'CREATE INDEX clicks_link_time_idx ON clicks (link_id, occurred_at)';
const VARIANTS: Variant[] = [
  { id: 'so-pk', create: [], drop: ['clicks_link_time_idx'] },
  { id: 'atual', create: [], drop: [] },
  {
    id: '+brin',
    create: ['CREATE INDEX clicks_wb_brin ON clicks USING brin (occurred_at)'],
    drop: [],
  },
  {
    id: '+btree-tempo',
    create: ['CREATE INDEX clicks_wb_time ON clicks (occurred_at)'],
    drop: [],
  },
  {
    id: '+cobrindo',
    create: [
      'CREATE INDEX clicks_wb_cover ON clicks (link_id, occurred_at) INCLUDE (kind, visitor, country)',
    ],
    drop: [],
  },
];

const EXTRA = [
  'clicks_wb_brin',
  'clicks_wb_time',
  'clicks_wb_cover',
  'clicks_cover_idx',
  'clicks_time_brin',
];

function parseArgs(argv: string[]) {
  const o = { batches: 60, rounds: 2, rawOnly: false };
  for (const a of argv) {
    if (a === '--raw-only') {
      o.rawOnly = true;
      continue;
    }
    const m = /^--(batches|rounds)=(\d+)$/.exec(a);
    if (m) o[m[1] as 'batches' | 'rounds'] = Number(m[2]);
    else if (a !== '--') throw new TypeError(`argumento inesperado: ${a}`);
  }
  return o;
}

type Row = Parameters<typeof insertBatch>[1][number];

/**
 * `--raw-only`: só o INSERT na bruta, com o mesmo unnest e o mesmo ON CONFLICT do worker, sem os
 * agregados. Isola o custo de manter os índices de `clicks` do resto da instrução.
 */
const RAW_INSERT = `
INSERT INTO clicks (event_id, link_id, occurred_at, kind, visitor, country, city, region,
                    referrer_domain, browser, os, device, preview_app)
SELECT * FROM unnest($1::uuid[], $2::bigint[], $3::timestamptz[], $4::text[], $5::text[], $6::text[],
                     $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[])
ORDER BY 3, 1
ON CONFLICT (occurred_at, event_id) DO NOTHING`;

async function rawInsert(sql: Sql, rows: Row[]) {
  const col = <K extends keyof Row>(k: K) => pgArray(rows.map((r) => r[k]));
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
  // Em transação desfeita: os índices são mantidos e o WAL é escrito de verdade, mas a bruta não
  // fica com linhas sem agregado (a consistência do bench continua exata).
  // A conexão é reservada (sem .begin): BEGIN/ROLLBACK explícitos.
  await sql.unsafe('BEGIN');
  try {
    await sql.unsafe(RAW_INSERT, params as never[]);
  } finally {
    await sql.unsafe('ROLLBACK');
  }
}

let RAW_ONLY = false;

function makeBatchFactory(linkIds: number[], weights: number[], seed: number) {
  const rnd = mulberry32(seed);
  const lt = thresholds(weights);
  const pt = thresholds(PLACES.map((p) => p[3]));
  const ft = thresholds(PLATFORMS.map((p) => p[3]));
  const visitor = () => {
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++) b[i] = Math.floor(rnd() * 256);
    return Buffer.from(b).toString('base64url').slice(0, 22);
  };
  return (size: number): Row[] => {
    const now = Date.now();
    return Array.from({ length: size }, (_, i) => {
      const r = rnd();
      const kind = r < 0.08 ? 'bot' : r < 0.13 ? 'preview' : 'human';
      const place = PLACES[bucket(rnd(), pt)]!;
      const plat = PLATFORMS[bucket(rnd(), ft)]!;
      return {
        eventId: uuidv7(now - (size - i)),
        linkId: String(linkIds[bucket(rnd(), lt)]!),
        occurredAt: new Date(now - (size - i)).toISOString(),
        kind,
        visitor: visitor(),
        country: place[0],
        city: kind === 'human' ? place[1] : null,
        region: kind === 'human' ? place[2] : null,
        referrerDomain: kind === 'human' ? 'google.com' : '(direto)',
        browser: plat[2],
        os: plat[1],
        device: plat[0],
        previewApp: kind === 'preview' ? 'whatsapp' : null,
      } satisfies Row;
    });
  };
}

interface RunResult {
  variant: string;
  workers: number;
  events: number;
  seconds: number;
  eventsPerSecond: number;
  batchP50: number;
  batchP95: number;
  walBytesPerEvent: number;
}

const walLsn = async (sql: Sql) =>
  BigInt(
    (
      await sql<{ b: string }[]>`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint AS b`
    )[0]!.b,
  );

async function runVariant(
  sql: Sql,
  v: string,
  workers: number,
  batches: number,
  factory: (n: number) => Row[],
): Promise<RunResult> {
  const durations: number[] = [];
  let next = 0;
  const wal0 = await walLsn(sql);
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: workers }, async () => {
      const conn = await sql.reserve();
      try {
        while (next < batches) {
          next++;
          const rows = factory(1000);
          const s = performance.now();
          if (RAW_ONLY) await rawInsert(conn as unknown as Sql, rows);
          else await insertBatch(conn as unknown as Sql, rows);
          durations.push(performance.now() - s);
        }
      } finally {
        conn.release();
      }
    }),
  );
  const seconds = (performance.now() - t0) / 1000;
  const wal = Number((await walLsn(sql)) - wal0);
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    variant: v,
    workers,
    events: batches * 1000,
    seconds,
    eventsPerSecond: (batches * 1000) / seconds,
    batchP50: median(durations),
    batchP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    walBytesPerEvent: wal / (batches * 1000),
  };
}

async function indexSizes(sql: Sql) {
  return sql<{ name: string; bytes: string }[]>`
    SELECT c.relname AS name,
           (SELECT coalesce(sum(pg_relation_size(i.inhrelid)), 0) FROM pg_inherits i WHERE i.inhparent = c.oid) AS bytes
    FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
    WHERE x.indrelid = 'clicks'::regclass ORDER BY 1`;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  RAW_ONLY = o.rawOnly;
  const sql = await benchSql({ max: 6, params: { application_name: 'bench-write' } });
  try {
    await readMeta(sql);
    for (const name of EXTRA) await sql.unsafe(`DROP INDEX IF EXISTS ${name}`);
    const model = await sql<{ link_id: string; weight: number }[]>`
      SELECT link_id, weight FROM bench.link_model WHERE weight > 0 ORDER BY link_id`;
    const factory = makeBatchFactory(
      model.map((m) => Number(m.link_id)),
      model.map((m) => m.weight),
      4242,
    );
    // Aquecimento: carrega os índices e os agregados quentes no cache.
    await runVariant(sql, 'aquecimento', 1, 10, factory);

    const results: RunResult[] = [];
    for (let round = 0; round < o.rounds; round++) {
      const order = round % 2 === 0 ? VARIANTS : [...VARIANTS].reverse();
      for (const v of order) {
        for (const d of v.drop) await sql.unsafe(`DROP INDEX ${d}`);
        for (const c of v.create) await sql.unsafe(c);
        await sql`CHECKPOINT`;
        for (const workers of [1, 4]) {
          const r = await runVariant(sql, v.id, workers, o.batches, factory);
          results.push(r);
          console.log(
            `rodada ${round + 1} ${v.id.padEnd(13)} ${workers} conexão(ões): ${Math.round(
              r.eventsPerSecond,
            )
              .toString()
              .padStart(
                6,
              )} eventos/s, lote p50 ${r.batchP50.toFixed(1)} ms p95 ${r.batchP95.toFixed(1)} ms, WAL ${Math.round(r.walBytesPerEvent)} B/evento`,
          );
        }
        if (v.create.length > 0) {
          for (const s of await indexSizes(sql)) {
            if (s.name.startsWith('clicks_wb_'))
              console.log(`  ${s.name}: ${fmtBytes(Number(s.bytes))}`);
          }
        }
        for (const c of v.create) await sql.unsafe(`DROP INDEX ${/INDEX (\S+)/.exec(c)![1]}`);
        if (v.drop.length > 0) await sql.unsafe(LINK_TIME);
      }
    }

    const summary = VARIANTS.flatMap((v) =>
      [1, 4].map((workers) => {
        const rs = results.filter((r) => r.variant === v.id && r.workers === workers);
        const avg = (f: (r: RunResult) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
        return {
          variant: v.id,
          workers,
          eventsPerSecond: Math.round(avg((r) => r.eventsPerSecond)),
          batchP50: Number(avg((r) => r.batchP50).toFixed(1)),
          batchP95: Number(avg((r) => r.batchP95).toFixed(1)),
          walBytesPerEvent: Math.round(avg((r) => r.walBytesPerEvent)),
        };
      }),
    );
    console.log(
      '\n| variante | conexões | eventos/s | lote p50 (ms) | lote p95 (ms) | WAL/evento |',
    );
    console.log('| - | -: | -: | -: | -: | -: |');
    for (const s of summary) {
      console.log(
        `| ${s.variant} | ${s.workers} | ${s.eventsPerSecond} | ${s.batchP50} | ${s.batchP95} | ${s.walBytesPerEvent} B |`,
      );
    }
    console.log('\nÍndices de clicks no fim (schema da migração):');
    for (const s of await indexSizes(sql)) console.log(`  ${s.name}: ${fmtBytes(Number(s.bytes))}`);
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(
      new URL(o.rawOnly ? 'write-raw.json' : 'write.json', RESULTS),
      JSON.stringify({ results, summary }, null, 2),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
