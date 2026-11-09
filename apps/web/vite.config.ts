import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../../', '');
  const apiPort = env.API_PORT ?? '3000';
  return {
    plugins: [react()],
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
