/**
 * Ambiente do e2e: um banco próprio (`encurtador_e2e`, recriado a cada execução), o Redis db 2 e
 * portas próprias, para nunca tocar no banco, no Redis nem nas portas do dev.
 */
export const E2E_DATABASE = 'encurtador_e2e';
export const E2E_REDIS_DB = 2;

export const PORTAS = { api: 3100, redirect: 8180, web: 4180, metricas: 9564 } as const;

export const WEB_URL = `http://localhost:${PORTAS.web}`;
export const SHORT_BASE_URL = `http://localhost:${PORTAS.redirect}`;

export function urls(
  base = process.env.DATABASE_URL ?? 'postgres://encurtador:encurtador@localhost:5433/encurtador',
) {
  const db = new URL(base);
  db.pathname = `/${E2E_DATABASE}`;
  const admin = new URL(base);
  admin.pathname = '/postgres';
  const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6380');
  redis.pathname = `/${E2E_REDIS_DB}`;
  return { db: db.href, admin: admin.href, redis: redis.href };
}

/** Navegador "humano" para os cliques do e2e (o redirect separa robôs pelo User-Agent). */
export const UA_HUMANO =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
