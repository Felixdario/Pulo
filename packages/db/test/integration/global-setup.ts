import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { MIGRATIONS_FOLDER, resolveUrls, TEST_DATABASE_NAME } from './env';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

/** Cria `encurtador_test` se não existir e aplica as migrações. Não toca no banco de dev. */
export default async function setup(project: TestProject) {
  const { adminUrl, testUrl } = resolveUrls();

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${TEST_DATABASE_NAME}`;
    if (rows.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  const sql = postgres(testUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end({ timeout: 5 });
  }

  project.provide('testDatabaseUrl', testUrl);
}
