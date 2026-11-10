import { createDb } from '@encurtador/db';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { db, close } = createDb(process.env.DATABASE_URL, { statementTimeoutMs: 10_000 });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', {
  maxRetriesPerRequest: 2,
});
const app = await buildApp({ db, redis, config });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'encerrando');
    void app
      .close()
      .then(() => redis.quit())
      .then(() => close())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
