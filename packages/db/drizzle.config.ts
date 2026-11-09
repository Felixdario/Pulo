import { defineConfig } from 'drizzle-kit';

process.loadEnvFile?.('../../.env');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://encurtador:encurtador@localhost:5433/encurtador',
  },
  strict: true,
  verbose: true,
});
