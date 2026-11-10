/**
 * Prepara o e2e: esvazia o Redis db 2, recria o banco `encurtador_e2e`, migra e roda o seed demo.
 * No fim grava `e2e:pronto` com o id da execução: redirect, worker e web esperam por ele.
 * Rodado pelo webServer da API no playwright.config.ts (`tsx apps/web/e2e/preparar.ts`).
 */
import { createDb, sql } from '@encurtador/db';
import { migrateDatabase } from '@encurtador/db/testing';
import { Redis } from 'ioredis';
import { seedDemo } from '../../api/src/seed/demo';
import { E2E_DATABASE, E2E_REDIS_DB, urls } from './ambiente';

const run = process.env.E2E_RUN;
if (!run) throw new Error('E2E_RUN não definido (rode pelo playwright)');
const u = urls(process.env.E2E_BASE_DATABASE_URL);

const redis = new Redis(u.redis, { maxRetriesPerRequest: 2 });
const info = (await redis.call('CLIENT', 'INFO')) as string;
if (/\bdb=(\d+)\b/.exec(info)?.[1] !== String(E2E_REDIS_DB)) {
  throw new Error(`recusando FLUSHDB fora do db ${E2E_REDIS_DB}`);
}
await redis.flushdb();

const admin = createDb(u.admin);
try {
  // Nome fixo: este script nunca apaga outro banco.
  await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${E2E_DATABASE}" WITH (FORCE)`));
  await admin.db.execute(sql.raw(`CREATE DATABASE "${E2E_DATABASE}"`));
} finally {
  await admin.close();
}
await migrateDatabase(u.db);

const e2e = createDb(u.db);
try {
  const r = await seedDemo(e2e.db);
  console.log(`e2e: banco ${E2E_DATABASE} pronto, ${r.links} links demo`);
} finally {
  await e2e.close();
}

await redis.set('e2e:pronto', run, 'EX', 3600);
await redis.quit();
