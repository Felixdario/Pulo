import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';
import { normalizeDatabaseUrl } from './src/url';

if (existsSync('../../.env')) process.loadEnvFile('../../.env');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: normalizeDatabaseUrl(
      process.env.DATABASE_URL ?? 'postgres://encurtador:encurtador@localhost:5433/encurtador',
    ),
  },
  strict: true,
  verbose: true,
});
