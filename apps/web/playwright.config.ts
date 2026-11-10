import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { PORTAS, SHORT_BASE_URL, urls, WEB_URL } from './e2e/ambiente';

/**
 * E2E contra a stack real: API, redirect, worker e web (build de produção no `vite preview`), com o
 * seed demo num banco próprio (`encurtador_e2e`, recriado a cada execução) e o Redis db 2. Portas
 * próprias (3100, 8180, 4180) para não brigar com o dev. O navegador é o Chrome instalado (canal
 * `chrome`): nada é baixado.
 */
const raiz = fileURLToPath(new URL('../../', import.meta.url));
if (existsSync(`${raiz}.env`)) process.loadEnvFile(`${raiz}.env`);

// Um id por execução: redirect, worker e web esperam o preparo DESTA execução.
process.env.E2E_RUN ??= String(Date.now());
const u = urls();
const geo = (f: string) => `${raiz}data/geo/${f}`;

const env: Record<string, string> = {
  E2E_RUN: process.env.E2E_RUN,
  NODE_ENV: 'development',
  DATABASE_URL: u.db,
  REDIS_URL: u.redis,
  JWT_SECRET: process.env.JWT_SECRET ?? 'segredo-do-e2e-com-pelo-menos-32-caracteres',
  API_PORT: String(PORTAS.api),
  REDIRECT_PORT: String(PORTAS.redirect),
  WEB_PORT: String(PORTAS.web),
  WEB_ORIGIN: WEB_URL,
  SHORT_BASE_URL,
  SHORT_DOMAINS: 'encurta.dev',
  WORKER_METRICS_PORT: String(PORTAS.metricas),
  GEO_CITY_MMDB: geo('dbip-city-lite.mmdb'),
  GEO_COUNTRY_MMDB: geo('dbip-country-lite.mmdb'),
  LOG_LEVEL: 'warn',
  // O Pub/Sub do Redis ignora o db: sem prefixo próprio, o demo (user 1) do e2e e o do dev
  // ouviriam os cliques um do outro.
  LIVE_CHANNEL_PREFIX: 'e2e-live:',
  // Um usuário (o demo) faz a suíte inteira: com o balde do ADR (120, +2/s), os testes de a11y e de
  // teclado da fase 8 esgotavam o limite e os seguintes recebiam 429. O limite tem teste próprio na
  // integração da API.
  API_RATE_LIMIT_CAPACITY: '5000',
  API_RATE_LIMIT_REFILL: '100',
};

const esperar = 'corepack pnpm --dir ../.. exec tsx apps/web/e2e/esperar.ts';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // As capturas do README só rodam quando pedidas (CAPTURAS=1).
  testIgnore: process.env.CAPTURAS === '1' ? [] : ['**/capturas.spec.ts'],
  // Uma stack e um banco compartilhados: os testes rodam em série.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    channel: 'chrome',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  webServer: [
    {
      name: 'api',
      command:
        'corepack pnpm --dir ../.. exec tsx apps/web/e2e/preparar.ts && corepack pnpm --filter @encurtador/api start',
      url: `http://localhost:${PORTAS.api}/healthz`,
      env,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      name: 'redirect',
      command: `${esperar} && corepack pnpm --filter @encurtador/redirect start`,
      url: `${SHORT_BASE_URL}/healthz`,
      env,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      name: 'worker',
      command: `${esperar} && corepack pnpm --filter @encurtador/worker start`,
      url: `http://localhost:${PORTAS.metricas}/metrics`,
      env,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      name: 'web',
      command: 'corepack pnpm exec vite build --logLevel warn && corepack pnpm exec vite preview',
      url: WEB_URL,
      // O build é de produção (React de produção e sem o painel de pior caso do dev).
      env: { ...env, NODE_ENV: 'production' },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
