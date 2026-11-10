import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Redis } from 'ioredis';
import postgres from 'postgres';
import type { Database } from './client';

/**
 * Utilitários de teste de integração, compartilhados pelos pacotes (`@encurtador/db/testing`).
 * Nunca tocam no banco `encurtador` nem no Redis db 0: o Postgres de teste é `encurtador_test`, o
 * Redis de teste é o db 1, e as funções destrutivas conferem isso no próprio servidor.
 */
export const TEST_DATABASE_NAME = 'encurtador_test';
export const TEST_REDIS_DB = 1;
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

export function loadRootEnv(): void {
  const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export function resolveTestUrls(): { adminUrl: string; testUrl: string } {
  if (!process.env.DATABASE_URL) loadRootEnv();
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL não definida (copie .env.example para .env)');
  const test = new URL(process.env.TEST_DATABASE_URL ?? base);
  test.pathname = `/${TEST_DATABASE_NAME}`;
  const admin = new URL(base);
  if (admin.pathname === `/${TEST_DATABASE_NAME}`) admin.pathname = '/postgres';
  return { adminUrl: admin.href, testUrl: test.href };
}

/** Cria `encurtador_test` se não existir e aplica as migrações. Devolve a URL dele. */
export async function ensureTestDatabase(): Promise<string> {
  const { adminUrl, testUrl } = resolveTestUrls();
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${TEST_DATABASE_NAME}`;
    if (rows.length === 0) await admin.unsafe(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
  } catch (err) {
    // Duas suítes criando ao mesmo tempo: a outra venceu.
    if (!(err instanceof Error && /already exists/.test(err.message))) throw err;
  } finally {
    await admin.end({ timeout: 5 });
  }
  await migrateDatabase(testUrl);
  return testUrl;
}

/** Aplica as migrações de `packages/db/drizzle` no banco da URL. */
export async function migrateDatabase(url: string): Promise<void> {
  const conn = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(conn), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await conn.end({ timeout: 5 });
  }
}

/**
 * Banco do seed grande e das medições da fase 5 (`packages/bench`). Fica no mesmo servidor, mas
 * separado do dev e do teste: pode ser apagado e recriado a qualquer momento.
 */
export const BENCH_DATABASE_NAME = 'encurtador_bench';

export function resolveBenchUrls(): { adminUrl: string; benchUrl: string } {
  if (!process.env.DATABASE_URL) loadRootEnv();
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL não definida (copie .env.example para .env)');
  const bench = new URL(process.env.BENCH_DATABASE_URL ?? base);
  bench.pathname = `/${BENCH_DATABASE_NAME}`;
  const admin = new URL(base);
  admin.pathname = '/postgres';
  return { adminUrl: admin.href, benchUrl: bench.href };
}

/** Apaga (se existir) e recria `encurtador_bench`, já migrado. O nome é fixo: nunca outro banco. */
export async function recreateBenchDatabase(): Promise<string> {
  const { adminUrl, benchUrl } = resolveBenchUrls();
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${BENCH_DATABASE_NAME}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${BENCH_DATABASE_NAME}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  await migrateDatabase(benchUrl);
  return benchUrl;
}

/** TRUNCATE só depois de confirmar, no próprio servidor, que estamos no banco de teste. */
export async function resetTestDb(db: Database): Promise<void> {
  const [row] = await db.execute<{ db: string }>(sql`SELECT current_database() AS db`);
  if (row?.db !== TEST_DATABASE_NAME) {
    throw new Error(`recusando TRUNCATE fora de ${TEST_DATABASE_NAME}: ${String(row?.db)}`);
  }
  await db.execute(
    sql`TRUNCATE idempotency_keys, api_keys, refresh_tokens, links, users, clicks, click_visitors, clicks_hourly, clicks_daily, clicks_daily_dim, clicks_daily_preview RESTART IDENTITY CASCADE`,
  );
}

/** REDIS_URL com o db trocado por 1. */
export function resolveTestRedisUrl(): string {
  if (!process.env.REDIS_URL) loadRootEnv();
  const base = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
  if (!base) throw new Error('REDIS_URL não definida (copie .env.example para .env)');
  const url = new URL(base);
  url.pathname = `/${TEST_REDIS_DB}`;
  return url.href;
}

/** FLUSHDB só se o servidor confirmar que a conexão está no db 1. */
export async function flushTestRedis(redis: Redis): Promise<void> {
  const info = (await redis.call('CLIENT', 'INFO')) as string;
  const db = /\bdb=(\d+)\b/.exec(info)?.[1];
  if (db !== String(TEST_REDIS_DB)) {
    throw new Error(`recusando FLUSHDB fora do db ${TEST_REDIS_DB}: db=${String(db)}`);
  }
  await redis.flushdb();
}
