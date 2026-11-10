/**
 * Pseudocódigos que aparecem em cabeçalhos de CDN e bases de geo e não são países: desconhecido
 * (XX, ZZ), Tor (T1), proxy anônimo (A1), satélite (A2), outro (O1), Europa (EU), Ásia-Pacífico (AP).
 */
const PSEUDO = new Set(['XX', 'ZZ', 'T1', 'A1', 'A2', 'O1', 'EU', 'AP']);

/**
 * País ISO 3166-1 alfa-2 em maiúsculas, ou null. Aceita minúsculas e espaços nas pontas; tudo que
 * não for duas letras, ou for pseudocódigo, vira null (país desconhecido, não erro).
 */
export function normalizeCountry(code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && !PSEUDO.has(c) ? c : null;
}
