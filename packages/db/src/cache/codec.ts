import { createHash } from 'node:crypto';
import { linkRulesSchema, type LinkRules } from '@encurtador/shared';
import type { Link, LinkStatus, RedirectType } from '../schema';

/** Versão do formato no cache. Mudar o formato = incrementar; valor de outra versão vira miss. */
export const CACHE_VERSION = 1;
/** Cache negativo: slug inexistente, apagado, desativado ou bloqueado. */
export const NEGATIVE = '∅';
export const NEGATIVE_TTL_SECONDS = 30;
export const LINK_TTL_SECONDS = 3600;

export const linkKey = (slug: string) => `l:${slug}`;

/** O que o redirect precisa de um link, e nada mais (sem hash de senha, sem dono). */
export interface RedirectLink {
  id: number;
  slug: string;
  destination: string;
  status: LinkStatus;
  redirectType: RedirectType;
  cacheTtl: number;
  /** epoch ms */
  expiresAt: number | null;
  maxClicks: number | null;
  rules: LinkRules;
  /** Resumo do hash da senha (muda quando a senha muda), ou null sem senha. Não é o hash. */
  passwordVersion: string | null;
  forwardQuery: boolean;
}

/** Formato compacto gravado em `l:<slug>`. */
interface Wire {
  v: number;
  i: number;
  s: string;
  d: string;
  st: LinkStatus;
  t: RedirectType;
  c: number;
  e: number | null;
  m: number | null;
  r: LinkRules;
  p: string | null;
  q: boolean;
}

export function passwordVersion(hash: string | null): string | null {
  return hash ? createHash('sha256').update(hash).digest('base64url').slice(0, 16) : null;
}

export function isServable(link: Pick<Link, 'status' | 'deletedAt'>): boolean {
  return link.status === 'active' && link.deletedAt === null;
}

export function toRedirectLink(link: Link): RedirectLink {
  const rules = linkRulesSchema.safeParse(link.rules ?? {});
  return {
    id: link.id,
    slug: link.slug,
    destination: link.destination,
    status: link.status,
    redirectType: link.redirectType,
    cacheTtl: link.cacheTtl,
    expiresAt: link.expiresAt ? link.expiresAt.getTime() : null,
    maxClicks: link.maxClicks,
    // Regra malformada no banco não derruba o redirect: cai no destino padrão.
    rules: rules.success ? rules.data : {},
    passwordVersion: passwordVersion(link.passwordHash),
    forwardQuery: link.forwardQuery,
  };
}

/** Valor do cache para uma linha do banco (ou ausência dela). Só link servível vira JSON. */
export function encodeLink(link: Link | null): string {
  if (!link || !isServable(link)) return NEGATIVE;
  const l = toRedirectLink(link);
  const wire: Wire = {
    v: CACHE_VERSION,
    i: l.id,
    s: l.slug,
    d: l.destination,
    st: l.status,
    t: l.redirectType,
    c: l.cacheTtl,
    e: l.expiresAt,
    m: l.maxClicks,
    r: l.rules,
    p: l.passwordVersion,
    q: l.forwardQuery,
  };
  return JSON.stringify(wire);
}

export type CacheLookup =
  | { kind: 'hit'; link: RedirectLink }
  | { kind: 'negative' }
  | { kind: 'miss' }
  /** Valor ilegível ou de outra versão: tratar como miss e sobrescrever. */
  | { kind: 'stale' };

export function decodeLink(raw: string | null | undefined): CacheLookup {
  if (raw === null || raw === undefined) return { kind: 'miss' };
  if (raw === NEGATIVE) return { kind: 'negative' };
  let w: Wire;
  try {
    w = JSON.parse(raw) as Wire;
  } catch {
    return { kind: 'stale' };
  }
  if (typeof w !== 'object' || w === null || w.v !== CACHE_VERSION) return { kind: 'stale' };
  return {
    kind: 'hit',
    link: {
      id: w.i,
      slug: w.s,
      destination: w.d,
      status: w.st,
      redirectType: w.t,
      cacheTtl: w.c,
      expiresAt: w.e,
      maxClicks: w.m,
      rules: w.r,
      passwordVersion: w.p,
      forwardQuery: w.q,
    },
  };
}

/** TTL de 1 h ± 10 %, para as entradas não expirarem todas juntas. */
export function jitteredTtl(base = LINK_TTL_SECONDS, random: () => number = Math.random): number {
  return Math.round(base * (0.9 + random() * 0.2));
}
