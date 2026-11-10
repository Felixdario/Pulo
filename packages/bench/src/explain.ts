import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ISql } from 'postgres';

/** Números de um `EXPLAIN (ANALYZE, BUFFERS, TIMING)` em texto. */
export interface PlanStats {
  executionMs: number;
  planningMs: number;
  /** Buffers do nó raiz (inclui os filhos): páginas achadas no shared_buffers. */
  hit: number;
  /** Páginas que o Postgres pediu ao sistema operacional (cache do SO ou disco). */
  read: number;
  /** Linhas que os nós de varredura de tabela/índice examinaram (devolvidas + descartadas). */
  rowsRead: number;
  /** Tempo de leitura (com track_io_timing), ms. */
  ioReadMs: number;
  jitMs: number;
  text: string;
}

const SCAN =
  /^\s*(?:->\s+)?(?:Parallel )?(Seq Scan|Index Scan(?: Backward)?|Index Only Scan(?: Backward)?|Bitmap Heap Scan)(?: using \S+)? on (\S+)(?: \S+)?\s+\(cost=[^)]*\) \(actual time=[\d.]+\.\.[\d.]+ rows=(\d+) loops=(\d+)\)/;
const NODE = /^\s*(?:->\s+)\S/;

export function parsePlan(text: string): PlanStats {
  const lines = text.split('\n');
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : 0;
  };
  let hit = 0;
  let read = 0;
  for (const line of lines) {
    if (/^\s*Planning:/.test(line)) break;
    const b = /^\s*Buffers: (.*)$/.exec(line);
    if (b) {
      hit = Number(/shared hit=(\d+)/.exec(b[1]!)?.[1] ?? 0);
      read = Number(/shared (?:hit=\d+ )?read=(\d+)/.exec(b[1]!)?.[1] ?? 0);
      break;
    }
  }
  let rowsRead = 0;
  let loops = 0;
  let inScan = false;
  for (const line of lines) {
    const m = SCAN.exec(line);
    if (m) {
      inScan = true;
      loops = Number(m[4]);
      rowsRead += Number(m[3]) * loops;
      continue;
    }
    if (NODE.test(line)) {
      inScan = false;
      continue;
    }
    if (!inScan) continue;
    const removed = /Rows Removed by (?:Filter|Index Recheck): (\d+)/.exec(line);
    if (removed) rowsRead += Number(removed[1]) * loops;
  }
  return {
    executionMs: num(/Execution Time: ([\d.]+) ms/),
    planningMs: num(/Planning Time: ([\d.]+) ms/),
    hit,
    read,
    rowsRead,
    ioReadMs: num(/I\/O Timings: shared read=([\d.]+)/),
    jitMs: num(
      /Timing: Generation [\d.]+ ms, Inlining [\d.]+ ms, Optimization [\d.]+ ms, Emission [\d.]+ ms, Total ([\d.]+) ms/,
    ),
    text,
  };
}

export interface Query {
  text: string;
  params?: unknown[];
}

export async function explain(conn: ISql, q: Query): Promise<PlanStats> {
  const rows = await conn.unsafe<{ 'QUERY PLAN': string }[]>(
    `EXPLAIN (ANALYZE, BUFFERS, TIMING) ${q.text}`,
    (q.params ?? []) as never[],
  );
  return parsePlan(rows.map((r) => r['QUERY PLAN']).join('\n'));
}

export const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Execução mediana de n (n ímpar): os números da tabela e o plano mostrado são da mesma execução. */
export function medianRun(runs: readonly PlanStats[]): PlanStats {
  const s = [...runs].sort((a, b) => a.executionMs - b.executionMs);
  return s[(s.length - 1) >> 1]!;
}

const run = promisify(execFile);

export function dockerBin(): string {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return `${process.env.LOCALAPPDATA}\\Programs\\DockerDesktop\\resources\\bin\\docker.exe`;
  }
  return 'docker';
}

/**
 * Cache frio: para o container do Postgres (o shared_buffers some), esvazia o page cache da VM do
 * Docker (`echo 3 > /proc/sys/vm/drop_caches` num container privilegiado da mesma imagem, sem baixar
 * nada) e sobe de novo, esperando aceitar conexões. Sem o segundo passo, o "frio" seria só frio para
 * o Postgres: o Linux da VM ainda teria as páginas na memória.
 */
export async function coldRestart(connect: () => Promise<void>): Promise<void> {
  const docker = dockerBin();
  const container = process.env.BENCH_PG_CONTAINER ?? 'encurtador-postgres-1';
  const [image] = (
    await run(docker, ['inspect', '--format', '{{.Config.Image}}', container])
  ).stdout.split('\n');
  await run(docker, ['stop', '-t', '30', container]);
  await run(docker, [
    'run',
    '--rm',
    '--privileged',
    '--entrypoint',
    'sh',
    image!.trim(),
    '-c',
    'sync; echo 3 > /proc/sys/vm/drop_caches',
  ]);
  await run(docker, ['start', container]);
  const t0 = Date.now();
  for (;;) {
    try {
      await connect();
      return;
    } catch (err) {
      if (Date.now() - t0 > 60_000) throw err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
