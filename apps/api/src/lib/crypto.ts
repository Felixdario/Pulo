import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSlugGenerator } from '@encurtador/shared';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');

/** Comparação em tempo constante de dois hashes base64url do mesmo tamanho. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** HMAC truncado de um IP: chave de rate limit sem guardar o IP (ADR 0002/0003). */
export const hmacKey = (secret: string, purpose: string, value: string) =>
  createHmac('sha256', secret).update(`${purpose}|${value}`).digest('base64url').slice(0, 22);

// Base62 por amostragem por rejeição, o mesmo gerador sem viés dos slugs (ADR 0001).
const prefixGen = createSlugGenerator({ lengthForAttempt: () => 8 });
const secretGen = createSlugGenerator({ lengthForAttempt: () => 32 });

export const API_KEY_REGEX = /^enc_([0-9A-Za-z]{8})_([0-9A-Za-z]{32})$/;

/** Nova chave `enc_<8>_<32>` (≈ 190 bits de segredo). */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = prefixGen();
  const key = `enc_${prefix}_${secretGen()}`;
  return { key, prefix, hash: sha256(key) };
}

/** JSON com chaves ordenadas: o mesmo corpo em outra ordem dá o mesmo hash de Idempotency-Key. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
