import { defineConfig } from 'vitest/config';

/**
 * `corepack pnpm test:consistency`: agregados × bruta no `encurtador_bench` (rode `seed:big` antes).
 * Um arquivo por vez: o ponta a ponta grava no mesmo banco que o outro confere.
 */
export default defineConfig({
  test: {
    include: ['test/consistency/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
