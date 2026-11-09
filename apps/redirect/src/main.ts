import { createDb } from '@encurtador/db';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { db, close: closeDb } = createDb(process.env.DATABASE_URL, { max: 20 });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', {
  // Autopipelining junta os comandos do mesmo tick num só write; sem fila offline, um Redis fora
  // falha na hora e o redirect cai para o Postgres em vez de esperar.
  enableAutoPipelining: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 1000,
  connectTimeout: 2000,
});
redis.on('error', () => {
  // Já contado e logado no caminho da requisição; evita "Unhandled error event".
});

const app = buildApp({ db, redis, config });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'encerrando');
    void app
      .close()
      .then(async () => {
        await app.clicks.flush();
        redis.disconnect();
        await closeDb();
      })
      .finally(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
