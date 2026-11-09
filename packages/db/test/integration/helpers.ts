import { sql } from 'drizzle-orm';
import { inject } from 'vitest';
import { createDb, type CreateDbOptions } from '../../src/index';
import { TEST_DATABASE_NAME } from './env';

export function testDb(options: CreateDbOptions = {}) {
  return createDb(inject('testDatabaseUrl'), { max: 20, ...options });
}

/** TRUNCATE só depois de confirmar, no próprio servidor, que estamos no banco de teste. */
export async function resetTestDb(db: ReturnType<typeof testDb>['db']): Promise<void> {
  const [row] = await db.execute<{ db: string }>(sql`SELECT current_database() AS db`);
  if (row?.db !== TEST_DATABASE_NAME) {
    throw new Error(`recusando TRUNCATE fora de ${TEST_DATABASE_NAME}: ${String(row?.db)}`);
  }
  await db.execute(sql`TRUNCATE links, users RESTART IDENTITY CASCADE`);
}

/** Gerador roteirizado: devolve os slugs na ordem e falha se acabar. */
export function scripted(...slugs: string[]) {
  let i = 0;
  const calls: number[] = [];
  const gen = (attempt = 0) => {
    calls.push(attempt);
    const s = slugs[i++];
    if (s === undefined) throw new Error('gerador roteirizado esgotado');
    return s;
  };
  return Object.assign(gen, { calls });
}
