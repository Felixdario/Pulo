import { describe, expect, it } from 'vitest';
import { runLoop } from './loop';

describe('runLoop', () => {
  it('para quando o sinal aborta', async () => {
    const controller = new AbortController();
    let ticks = 0;
    const iterations = await runLoop({
      signal: controller.signal,
      intervalMs: 1,
      tick: () => {
        ticks++;
        if (ticks === 3) controller.abort();
      },
    });
    expect(iterations).toBe(3);
  });
});
