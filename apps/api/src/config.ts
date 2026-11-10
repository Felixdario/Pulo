import type { BucketConfig } from '@encurtador/db/cache';
import { compileCidrs, normalizeShortDomains } from '@encurtador/shared';

export interface ApiConfig {
  port: number;
  logLevel: string;
  /** Segredo HS256 do access token (≥ 32 caracteres). */
  jwtSecret: string;
  /** Segredo dos HMAC de IP (rate limit por visitante). Padrão: o do JWT. */
  hmacSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** Produção (ou COOKIE_SECURE=1): cookie `__Host-refresh` com `Secure`; em dev, `refresh`. */
  secureCookies: boolean;
  /** Origens aceitas pelo CORS (só o front). */
  webOrigins: string[];
  /** Domínios curtos já normalizados (uma vez, na partida): destino neles é loop. */
  shortDomains: string[];
  /** Base dos links curtos devolvidos em `short_url` (o serviço de redirect). */
  shortBaseUrl: string;
  trustProxy: string[];
  devTrustXff: boolean;
  /** `RATE_LIMIT=off` desliga os baldes (só medição). */
  rateLimit: boolean;
  /** Por usuário ou chave (ADR 0004): 120 de capacidade, 2/s. */
  bucket: BucketConfig;
  /** Login e cadastro: 10/min por IP (HMAC) e por e-mail. */
  authBucket: BucketConfig;
  /** Encurtar sem login: 10/min por visitante. */
  publicBucket: BucketConfig;
  publicLinkTtlDays: number;
  liveHeartbeatMs: number;
  liveTicketTtlSeconds: number;
  /**
   * Prefixo do canal Pub/Sub do ao vivo (`<prefixo><user_id>`), o mesmo do worker. O Pub/Sub do
   * Redis ignora o db: os testes usam um prefixo único para não ouvir (nem contar) o dev.
   */
  liveChannelPrefix: string;
  preview: {
    timeoutMs: number;
    maxBytes: number;
    maxRedirects: number;
    cacheTtlSeconds: number;
  };
}

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`número inválido: "${v}"`);
  return n;
};

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const production = env.NODE_ENV === 'production';
  const jwtSecret = env.JWT_SECRET?.trim() ?? '';
  if (jwtSecret.length < 32) throw new TypeError('JWT_SECRET precisa ter pelo menos 32 caracteres');
  const trustProxy = list(env.TRUST_PROXY);
  compileCidrs(trustProxy);
  const webPort = num(env.WEB_PORT, 5173);
  const redirectPort = num(env.REDIRECT_PORT, 8080);
  const webOrigins = list(env.WEB_ORIGIN ?? `http://localhost:${webPort}`);
  for (const origin of webOrigins) {
    if (new URL(origin).origin !== origin) throw new TypeError(`WEB_ORIGIN inválida: "${origin}"`);
  }
  return {
    port: num(env.API_PORT, 3000),
    logLevel: env.LOG_LEVEL ?? (production ? 'warn' : 'info'),
    jwtSecret,
    hmacSecret: env.API_SECRET?.trim() || jwtSecret,
    accessTtlSeconds: 15 * 60,
    refreshTtlSeconds: 30 * 24 * 3600,
    secureCookies: production || env.COOKIE_SECURE === '1',
    webOrigins,
    // Falha na partida se a lista estiver malformada, em vez de desligar a proteção de loop.
    shortDomains: normalizeShortDomains(list(env.SHORT_DOMAINS ?? 'encurta.dev')),
    shortBaseUrl: (env.SHORT_BASE_URL ?? `http://localhost:${redirectPort}`).replace(/\/+$/, ''),
    trustProxy,
    devTrustXff: env.DEV_TRUST_XFF === '1',
    rateLimit: env.RATE_LIMIT?.trim().toLowerCase() !== 'off',
    bucket: {
      capacity: num(env.API_RATE_LIMIT_CAPACITY, 120),
      refillPerSecond: num(env.API_RATE_LIMIT_REFILL, 2),
    },
    authBucket: { capacity: 10, refillPerSecond: 10 / 60 },
    publicBucket: { capacity: 10, refillPerSecond: 10 / 60 },
    publicLinkTtlDays: 30,
    liveHeartbeatMs: 15_000,
    liveTicketTtlSeconds: 30,
    liveChannelPrefix: env.LIVE_CHANNEL_PREFIX?.trim() || 'live:',
    preview: { timeoutMs: 3000, maxBytes: 512 * 1024, maxRedirects: 3, cacheTtlSeconds: 3600 },
  };
}
