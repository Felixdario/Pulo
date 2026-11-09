/**
 * Carga do redirect (fase 2): `corepack pnpm bench:redirect`.
 *
 * Sobe o redirect em modo produção (logger em warn) para cada cenário, garante o link `bench-hot` no
 * banco de dev, aquece 5 s e mede 30 s com autocannon (50 conexões). Cada cenário roda 2×.
 * Os eventos vão para o stream `bench:clicks` (MAXLEN ~10.000), apagado no fim; nada do dev é
 * alterado além do link `bench-hot` e das chaves de cache dele.
 *
 * Opções: BENCH_DURATION (s, padrão 30), BENCH_WARMUP (s, 5), BENCH_RUNS (2), BENCH_ONLY (nomes
 * separados por vírgula), BENCH_PORT (8099).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createDb, createLink, findLinkBySlug } from '@encurtador/db';
import autocannon from 'autocannon';
import { Redis } from 'ioredis';

const root = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

const DURATION = Number(process.env.BENCH_DURATION ?? 30);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 5);
const RUNS = Number(process.env.BENCH_RUNS ?? 2);
const PORT = Number(process.env.BENCH_PORT ?? 8099);
const CONNECTIONS = 50;
const STREAM = 'bench:clicks';

interface Scenario {
  name: string;
  description: string;
  path: string;
  env: Record<string, string>;
}

// Bucket ligado com capacidade enorme: o script Lua roda inteiro, mas um IP só nunca é barrado.
const BUCKET_ON = { RATE_LIMIT_CAPACITY: '1000000000', RATE_LIMIT_REFILL: '1000000000' };

const SCENARIOS: Scenario[] = [
  {
    name: 'quente-1ida',
    description: 'cache quente, bucket + GET num só Lua (1 ida ao Redis, 0 ao Postgres)',
    path: '/bench-hot?utm_campaign=carga',
    env: { ...BUCKET_ON, REDIS_ROUNDTRIPS: '1' },
  },
  {
    name: 'quente-2idas',
    description: 'cache quente, EVALSHA do bucket + GET separado (2 idas ao Redis)',
    path: '/bench-hot?utm_campaign=carga',
    env: { ...BUCKET_ON, REDIS_ROUNDTRIPS: '2' },
  },
  {
    name: 'sem-cache',
    description: 'CACHE=off: bucket no Redis + SELECT no Postgres a cada requisição',
    path: '/bench-hot?utm_campaign=carga',
    env: { ...BUCKET_ON, CACHE: 'off' },
  },
  {
    name: 'negativo',
    description: 'slug inexistente: cache negativo ∅ (1 ida ao Redis, 404)',
    path: '/bench-nao-existe',
    env: { ...BUCKET_ON, REDIS_ROUNDTRIPS: '1' },
  },
];

interface RunResult {
  scenario: string;
  run: number;
  requests: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  statuses: Record<string, number>;
  errors: number;
  timeouts: number;
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

async function waitHealthy(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // ainda subindo
    }
    if (Date.now() - start > timeoutMs) throw new Error(`redirect não subiu em ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function startServer(env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/redirect/src/main.ts'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      REDIRECT_PORT: String(PORT),
      CLICKS_STREAM: STREAM,
      CLICKS_MAXLEN: '10000',
      ...env,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return child;
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function cannon(url: string, seconds: number, collect: boolean) {
  return new Promise<{
    latencies: Float64Array;
    result: autocannon.Result;
    statuses: Record<string, number>;
  }>((resolve, reject) => {
    let buf = new Float64Array(1 << 20);
    let n = 0;
    const statuses: Record<string, number> = {};
    const instance = autocannon(
      {
        url,
        connections: CONNECTIONS,
        duration: seconds,
        headers: { 'user-agent': 'Mozilla/5.0 bench' },
      },
      (err, result) => {
        if (err) reject(err);
        else resolve({ latencies: buf.subarray(0, n), result, statuses });
      },
    );
    instance.on('response', (_client: unknown, statusCode: number, _bytes: number, ms: number) => {
      statuses[statusCode] = (statuses[statusCode] ?? 0) + 1;
      if (!collect) return;
      if (n === buf.length) {
        const next = new Float64Array(buf.length * 2);
        next.set(buf);
        buf = next;
      }
      buf[n++] = ms;
    });
  });
}

async function main() {
  const only = process.env.BENCH_ONLY?.split(',').map((s) => s.trim());
  const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;

  const { db, close } = createDb(process.env.DATABASE_URL);
  if (!(await findLinkBySlug(db, 'bench-hot'))) {
    await createLink(db, {
      destination: 'https://example.com/bench?utm_source=encurtador',
      alias: 'bench-hot',
    });
    console.log('link bench-hot criado no banco de dev');
  }
  await close();

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380');
  const results: RunResult[] = [];

  console.log(
    `máquina: ${os.cpus()[0]?.model} × ${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB, ${os.type()} ${os.release()}, Node ${process.version}`,
  );
  console.log(`${CONNECTIONS} conexões, aquecimento ${WARMUP} s, medição ${DURATION} s, ${RUNS}×`);

  try {
    for (const s of scenarios) {
      for (let run = 1; run <= RUNS; run++) {
        const child = startServer(s.env);
        try {
          await waitHealthy(`http://127.0.0.1:${PORT}/healthz`);
          const url = `http://127.0.0.1:${PORT}${s.path}`;
          await cannon(url, WARMUP, false);
          const { latencies, result, statuses } = await cannon(url, DURATION, true);
          latencies.sort();
          const r: RunResult = {
            scenario: s.name,
            run,
            requests: latencies.length,
            rps: Math.round(latencies.length / DURATION),
            p50: percentile(latencies, 50),
            p95: percentile(latencies, 95),
            p99: percentile(latencies, 99),
            max: latencies[latencies.length - 1] ?? NaN,
            statuses,
            errors: result.errors,
            timeouts: result.timeouts,
          };
          results.push(r);
          console.log(
            `${s.name} #${run}: ${r.rps} req/s, p50 ${r.p50.toFixed(2)} ms, p95 ${r.p95.toFixed(2)} ms, p99 ${r.p99.toFixed(2)} ms, max ${r.max.toFixed(1)} ms, status ${JSON.stringify(statuses)}, erros ${r.errors}, timeouts ${r.timeouts}`,
          );
        } finally {
          await stopServer(child);
          await redis.del(STREAM);
        }
      }
    }
  } finally {
    await redis.del(STREAM);
    redis.disconnect();
  }

  const out = process.env.BENCH_OUT;
  if (out) writeFileSync(out, JSON.stringify({ scenarios, results }, null, 2));

  console.log('\n| Cenário | Rodada | req/s | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | erros |');
  console.log('| - | - | -: | -: | -: | -: | -: | -: |');
  for (const r of results) {
    console.log(
      `| ${r.scenario} | ${r.run} | ${r.rps} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ${r.p99.toFixed(2)} | ${r.max.toFixed(1)} | ${r.errors + r.timeouts} |`,
    );
  }
}

await main();
