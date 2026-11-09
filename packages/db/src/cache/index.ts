import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Link } from '../schema';
import {
  decodeLink,
  encodeLink,
  jitteredTtl,
  linkKey,
  NEGATIVE,
  NEGATIVE_TTL_SECONDS,
  type CacheLookup,
} from './codec';
import { BUCKET_GET, CLICK_CAP, runScript } from './scripts';

export * from './codec';
export { BUCKET_GET, CLICK_CAP, runScript, type LuaScript } from './scripts';

const ttlFor = (value: string) => (value === NEGATIVE ? NEGATIVE_TTL_SECONDS : jitteredTtl());

/**
 * Preenchimento de quem lê (cache-aside): `SET NX`. Se a API já gravou um valor mais novo
 * (write-through), o NX falha e o valor novo fica. Devolve se gravou.
 */
export async function readThroughFill(
  redis: Redis,
  slug: string,
  link: Link | null,
): Promise<boolean> {
  const value = encodeLink(link);
  const r = await redis.set(linkKey(slug), value, 'EX', ttlFor(value), 'NX');
  return r === 'OK';
}

/**
 * Write-through da API depois do commit: `SET` incondicional. `null` (ou link apagado/desativado)
 * grava o cache negativo por 30 s. Criar um link também chama isto, apagando um `∅` antigo.
 */
export async function writeThrough(redis: Redis, slug: string, link: Link | null): Promise<void> {
  const value = encodeLink(link);
  await redis.set(linkKey(slug), value, 'EX', ttlFor(value));
}

export async function getCachedLink(redis: Redis, slug: string): Promise<CacheLookup> {
  return decodeLink(await redis.get(linkKey(slug)));
}

export interface BucketConfig {
  capacity: number;
  /** Fichas repostas por segundo. */
  refillPerSecond: number;
}

export interface BucketResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  /** Tempo até o balde encher de novo. */
  resetMs: number;
}

/**
 * Consome 1 ficha do balde `bucketKey` e, se permitido e `slug` dado, lê `l:<slug>` na mesma ida.
 * `nowMs` só existe para testes determinísticos; em produção vale o TIME do Redis.
 */
export async function takeTokenAndGet(
  redis: Redis,
  bucketKey: string,
  bucket: BucketConfig,
  slug?: string,
  nowMs?: number,
): Promise<BucketResult & { lookup: CacheLookup | null }> {
  const keys = slug === undefined ? [bucketKey] : [bucketKey, linkKey(slug)];
  const r = (await runScript(redis, BUCKET_GET, keys, [
    bucket.capacity,
    bucket.refillPerSecond,
    nowMs ?? '',
    1,
  ])) as [number, number, number, number, string | null];
  const allowed = r[0] === 1;
  return {
    allowed,
    remaining: r[1],
    retryAfterMs: r[2],
    resetMs: r[3],
    lookup: allowed && slug !== undefined ? decodeLink(r[4]) : null,
  };
}

export const capKey = (linkId: number) => `cap:${linkId}`;
const CAP_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Limite de cliques. `incr` conta um clique humano e devolve o total já com ele; `peek` (robôs e
 * prévias) só lê. Na primeira vez, inicializa com `SET NX` a partir de `loadInitial()` (total do
 * banco).
 */
export async function clickCount(
  redis: Redis,
  linkId: number,
  mode: 'incr' | 'peek',
  loadInitial: () => Promise<number>,
): Promise<number> {
  const key = capKey(linkId);
  let r = (await runScript(redis, CLICK_CAP, [key], [mode, '', CAP_TTL_SECONDS])) as number | null;
  if (r === null) {
    const initial = await loadInitial();
    r = (await runScript(redis, CLICK_CAP, [key], [mode, initial, CAP_TTL_SECONDS])) as number;
  }
  return r;
}

export const saltKey = (day: string) => `salt:${day}`;
const SALT_TTL_SECONDS = 48 * 3600;

/** Dia UTC no formato AAAA-MM-DD. */
export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);

/**
 * Sal diário (ADR 0003): 32 bytes aleatórios em `salt:<AAAA-MM-DD>`, criado por quem chegar
 * primeiro (`SET NX … GET`, uma ida só) e com TTL de 48 h. `candidate` permite propor um sal gerado
 * antes (ex.: enquanto o Redis estava fora).
 */
export async function dailySalt(
  redis: Redis,
  day: string = utcDay(),
  candidate: string = randomBytes(32).toString('base64'),
): Promise<string> {
  const previous = (await redis.call(
    'SET',
    saltKey(day),
    candidate,
    'NX',
    'EX',
    SALT_TTL_SECONDS,
    'GET',
  )) as string | null;
  return previous ?? candidate;
}
