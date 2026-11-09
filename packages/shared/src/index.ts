/** Versão do pacote compartilhado; usada pelos apps para provar o link entre pacotes. */
export const SHARED_VERSION = '0.0.0';

/**
 * Slugs que nunca podem ser gerados nem escolhidos como alias. Preenchido na fase 1 (ADR 0001).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set<string>();

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}
