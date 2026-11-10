import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = ReturnType<typeof createDb>['db'];

export interface CreateDbOptions {
  /** Tamanho do pool. Padrão: 10. */
  max?: number;
  /** Recebe cada query enviada (usado nos testes para provar que não há SELECT antes do INSERT). */
  onQuery?: (query: string) => void;
  /** `statement_timeout` da sessão, em ms: uma espera de lock não prende o processo para sempre. */
  statementTimeoutMs?: number;
}

/**
 * Cria o cliente do banco. Não conecta na hora: o `postgres` só abre conexão na primeira query.
 */
export function createDb(
  url: string | undefined = process.env.DATABASE_URL,
  options: CreateDbOptions = {},
) {
  if (!url) {
    throw new Error('DATABASE_URL não definida');
  }
  const { onQuery } = options;
  const sql = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    ...(onQuery ? { debug: (_conn: number, query: string) => onQuery(query) } : {}),
    ...(options.statementTimeoutMs
      ? { connection: { statement_timeout: options.statementTimeoutMs } }
      : {}),
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
