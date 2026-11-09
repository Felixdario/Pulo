import { setTimeout as sleep } from 'node:timers/promises';

export interface LoopOptions {
  signal: AbortSignal;
  intervalMs: number;
  tick: () => Promise<void> | void;
}

/**
 * Loop placeholder do consumidor de cliques (fase 3, ADR 0003). Roda `tick` até o sinal abortar e
 * devolve quantas iterações completou.
 */
export async function runLoop({ signal, intervalMs, tick }: LoopOptions): Promise<number> {
  let iterations = 0;
  while (!signal.aborted) {
    await tick();
    iterations++;
    try {
      await sleep(intervalMs, undefined, { signal });
    } catch {
      break;
    }
  }
  return iterations;
}
