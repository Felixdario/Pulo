import { BENCH_DATABASE_NAME, resolveBenchUrls } from '@encurtador/db/testing';
import postgres, { type ReservedSql, type Sql } from 'postgres';

export { BENCH_DATABASE_NAME };

export interface BenchConnOptions {
  max?: number;
  /** Parâmetros de sessão (work_mem etc.), aplicados na conexão. */
  params?: Record<string, string>;
}

/** Conexão com o `encurtador_bench`. Confere no servidor que é ele antes de devolver. */
export async function benchSql(o: BenchConnOptions = {}): Promise<Sql> {
  const { benchUrl } = resolveBenchUrls();
  const sql = postgres(benchUrl, {
    max: o.max ?? 4,
    onnotice: () => {},
    idle_timeout: 30,
    ...(o.params ? { connection: o.params } : {}),
  });
  const [row] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  if (row?.db !== BENCH_DATABASE_NAME) {
    await sql.end();
    throw new Error(`esperava ${BENCH_DATABASE_NAME}, conectou em ${String(row?.db)}`);
  }
  return sql;
}

export interface BenchMeta {
  options: Record<string, unknown>;
  startMs: number;
  endMs: number;
  hotLink: number;
  coldLink: number;
  zeroLinks: number[];
  hotUser: number;
  timings: Record<string, number>;
}

/** Metadados gravados pelo seed (`bench.meta`): período, links quente/frio, usuário quente. */
export async function readMeta(sql: Sql): Promise<BenchMeta> {
  const [row] = await sql<{ v: BenchMeta }[]>`SELECT v FROM bench.meta WHERE k = 'seed'`.catch(
    () => [],
  );
  if (!row) throw new Error('encurtador_bench sem seed: rode `corepack pnpm seed:big` antes');
  return row.v;
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString('pt-BR');
export const fmtMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${ms.toFixed(0)} ms`;
export const fmtBytes = (b: number) => {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} kB`;
  return `${b} B`;
};

/** Executa tarefas com no máximo `jobs` em paralelo, cada uma numa conexão reservada. */
export async function runPool<T>(
  sql: Sql,
  jobs: number,
  tasks: readonly T[],
  run: (conn: ReservedSql, task: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
      const conn = await sql.reserve();
      try {
        while (next < tasks.length) {
          const i = next++;
          await run(conn, tasks[i]!, i);
        }
      } finally {
        conn.release();
      }
    }),
  );
}
