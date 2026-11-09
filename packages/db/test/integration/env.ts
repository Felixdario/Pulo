import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEST_DATABASE_NAME = 'encurtador_test';
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * URL do banco de teste: TEST_DATABASE_URL, ou DATABASE_URL com o nome do banco trocado por
 * `encurtador_test`. Recusa qualquer outro nome, para que TRUNCATE nunca atinja o banco de dev.
 */
export function resolveUrls(): { adminUrl: string; testUrl: string } {
  const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL não definida (copie .env.example para .env)');

  const test = new URL(process.env.TEST_DATABASE_URL ?? base);
  test.pathname = `/${TEST_DATABASE_NAME}`;
  const admin = new URL(base);
  if (admin.pathname === `/${TEST_DATABASE_NAME}`) admin.pathname = '/postgres';
  return { adminUrl: admin.href, testUrl: test.href };
}
