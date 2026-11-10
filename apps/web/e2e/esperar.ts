/** Espera o `preparar.ts` desta execução terminar (chave `e2e:pronto` = E2E_RUN no Redis db 2). */
import { Redis } from 'ioredis';
import { urls } from './ambiente';

const run = process.env.E2E_RUN;
if (!run) throw new Error('E2E_RUN não definido (rode pelo playwright)');
const redis = new Redis(urls(process.env.E2E_BASE_DATABASE_URL).redis, { maxRetriesPerRequest: 2 });
const limite = Date.now() + 180_000;
while ((await redis.get('e2e:pronto')) !== run) {
  if (Date.now() > limite) throw new Error('o preparo do e2e não terminou em 3 min');
  await new Promise((r) => setTimeout(r, 500));
}
await redis.quit();
