import type { BucketConfig } from '@encurtador/db/cache';
import { compileCidrs } from '@encurtador/shared';

export interface RedirectConfig {
  port: number;
  logLevel: string;
  /** `CACHE=off`: sempre vai ao banco, sem ler nem preencher o Redis (para medir sem cache). */
  cache: boolean;
  /** `RATE_LIMIT=off`: sem token bucket no GET (bench de um IP só). */
  rateLimit: boolean;
  /** `REDIS_ROUNDTRIPS=2`: bucket e GET em idas separadas, para comparar com o Lua único. */
  redisRoundTrips: 1 | 2;
  bucket: BucketConfig;
  passwordBucket: BucketConfig;
  /** CIDRs de proxies confiáveis (`TRUST_PROXY`). Vazio: não confia em ninguém. */
  trustProxy: string[];
  /** `DEV_TRUST_XFF=1`: aceita X-Forwarded-For e X-Country de qualquer um (só testes locais). */
  devTrustXff: boolean;
  /** Segredo do HMAC dos cookies de desbloqueio e das chaves de rate limit. */
  secret: string;
  secureCookies: boolean;
  clicksStream: string;
  clicksMaxLen: number;
  clicksBufferLimit: number;
  /** Relógio do bucket; só testes. Em produção vale o TIME do Redis. */
  bucketNow?: () => number;
}

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`número inválido: "${v}"`);
  return n;
};

const off = (v: string | undefined) => v?.trim().toLowerCase() === 'off';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RedirectConfig {
  const production = env.NODE_ENV === 'production';
  const secret = env.REDIRECT_SECRET?.trim() || env.JWT_SECRET?.trim() || '';
  if (secret.length < 32) {
    throw new TypeError('REDIRECT_SECRET (ou JWT_SECRET) precisa ter pelo menos 32 caracteres');
  }
  const trustProxy = (env.TRUST_PROXY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  compileCidrs(trustProxy); // valida já na subida
  const roundTrips = env.REDIS_ROUNDTRIPS?.trim() === '2' ? 2 : 1;
  return {
    port: num(env.REDIRECT_PORT, 8080),
    logLevel: env.LOG_LEVEL ?? (production ? 'warn' : 'info'),
    cache: !off(env.CACHE),
    rateLimit: !off(env.RATE_LIMIT),
    redisRoundTrips: roundTrips,
    bucket: {
      capacity: num(env.RATE_LIMIT_CAPACITY, 60),
      refillPerSecond: num(env.RATE_LIMIT_REFILL, 10),
    },
    passwordBucket: { capacity: 5, refillPerSecond: 5 / 60 },
    trustProxy,
    devTrustXff: env.DEV_TRUST_XFF === '1',
    secret,
    secureCookies: production || env.COOKIE_SECURE === '1',
    clicksStream: env.CLICKS_STREAM ?? 'clicks',
    clicksMaxLen: num(env.CLICKS_MAXLEN, 1_000_000),
    clicksBufferLimit: 10_000,
  };
}
