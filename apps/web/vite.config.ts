/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // O .env da raiz; variáveis já definidas no processo (o e2e sobe em outras portas) têm prioridade.
  const env = { ...loadEnv(mode, '../../', ''), ...process.env };
  const apiPort = env.API_PORT ?? '3000';
  const proxy = {
    '/api': {
      target: `http://localhost:${apiPort}`,
      rewrite: (path: string) => path.replace(/^\/api/, ''),
    },
  };
  return {
    plugins: [react()],
    server: { port: Number(env.WEB_PORT ?? 5173), strictPort: true, proxy },
    preview: { port: Number(env.WEB_PORT ?? 4173), strictPort: true, proxy },
    test: {
      include: ['src/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
    },
  };
});
