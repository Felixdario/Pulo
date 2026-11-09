import { SHARED_VERSION } from '@encurtador/shared';
import { pino } from 'pino';
import { runLoop } from './loop';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'encerrando');
    controller.abort();
  });
}

log.info({ shared: SHARED_VERSION }, 'worker iniciado');
const iterations = await runLoop({
  signal: controller.signal,
  intervalMs: 5_000,
  tick: () => log.debug('tick'),
});
log.info({ iterations }, 'worker encerrado');
