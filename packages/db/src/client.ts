import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = ReturnType<typeof createDb>['db'];

/**
 * Cria o cliente do banco. Não conecta na hora: o `postgres` só abre conexão na primeira query.
 */
export function createDb(url: string | undefined = process.env.DATABASE_URL) {
  if (!url) {
    throw new Error('DATABASE_URL não definida');
  }
  const sql = postgres(url, { max: 10 });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
