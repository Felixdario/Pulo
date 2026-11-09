import { buildApp } from './app';

const port = Number(process.env.API_PORT ?? 3000);
const app = await buildApp({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'encerrando');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host: '0.0.0.0' });
