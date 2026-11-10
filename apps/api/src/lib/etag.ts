import { createHash } from 'node:crypto';

/** ETag fraco de um corpo (ADR 0004): `W/"<hash>"`. */
export const weakEtag = (body: string | Buffer) =>
  `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;

/**
 * ETag forte de um link: id + `updated_at` em µs. Transparente de propósito: o `If-Match` do PATCH
 * é comparado no próprio UPDATE (`updated_at` = versão), sem ler a linha antes.
 */
export const linkEtag = (id: number, updatedUs: string) => `"l${id}.${updatedUs}"`;

export function parseLinkEtag(tag: string): { id: number; version: string } | null {
  const m = /^"l(\d+)\.(\d+)"$/.exec(tag.trim());
  return m ? { id: Number(m[1]), version: m[2]! } : null;
}

/** Lista de um cabeçalho `If-None-Match`/`If-Match` (`*` incluído). */
export const etagList = (header: string | undefined) =>
  (header ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

const opaque = (tag: string) => tag.replace(/^W\//, '');

/** Comparação fraca (RFC 9110 §8.8.3.2), a do `If-None-Match`. */
export const weakMatch = (header: string | undefined, etag: string) =>
  etagList(header).some((t) => t === '*' || opaque(t) === opaque(etag));
