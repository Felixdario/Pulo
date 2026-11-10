import { createServer } from 'node:http';
import { createDb } from '@encurtador/db';
import { createMmdbGeoLookup } from '@encurtador/geo';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config';
import { ClickWorker } from './worker';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const config = loadConfig();
const { sql, close: closeDb } = createDb(process.env.DATABASE_URL, {
  max: 4,
  statementTimeoutMs: config.statementTimeoutMs,
});
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const blockingRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
for (const r of [redis, blockingRedis])
  r.on('error', (err) => log.warn({ err: err.message }, 'redis'));

const geo = await createMmdbGeoLookup(undefined, log);
const worker = new ClickWorker({ sql, redis, blockingRedis, geo, config, log });
await worker.start();

const server = createServer((req, res) => {
  if (req.url === '/metrics') {
    worker.metrics.registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': worker.metrics.registry.contentType });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
    return;
  }
  res.writeHead(req.url === '/healthz' ? 200 : 404, { 'content-type': 'text/plain' });
  res.end(req.url === '/healthz' ? 'ok' : 'not found');
});
server.listen(config.metricsPort, () => log.info({ port: config.metricsPort }, 'métricas no ar'));

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'encerrando: terminando o lote atual');
    void (async () => {
      await worker.stop();
      server.close();
      redis.disconnect();
      blockingRedis.disconnect();
      await closeDb();
      log.info('worker encerrado');
      process.exit(0);
    })();
  });
}
