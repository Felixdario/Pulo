/**
 * Caminhos que nunca são slug nem alias (ADR 0001), comparados sem diferenciar maiúsculas. Os que
 * têm ponto já não passam no formato de alias, mas ficam aqui para o redirect saber o que não é slug.
 */
const RESERVED = [
  // Lista do ADR 0001
  'api',
  'v1',
  'docs',
  'metrics',
  'health',
  'healthz',
  'ready',
  'admin',
  'login',
  'logout',
  'signup',
  'app',
  'dashboard',
  'static',
  'assets',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  '.well-known',
  'www',
  'qr',
  's',
  'l',
  // Variações óbvias
  'v2',
  'v3',
  'api-docs',
  'openapi',
  'swagger',
  'docs-json',
  'readyz',
  'livez',
  'status',
  'ping',
  'administrator',
  'signin',
  'sign-in',
  'sign-up',
  'sign-out',
  'register',
  'auth',
  'oauth',
  'account',
  'settings',
  'favicon',
  'favicon.png',
  'favicon.svg',
  'apple-touch-icon.png',
  'manifest.json',
  'manifest.webmanifest',
  'robots',
  'sitemap',
  'security.txt',
  'humans.txt',
  'ads.txt',
  'help',
  'about',
  'terms',
  'privacy',
  'abuse',
  'blocked',
  'expired',
  'password',
  'preview',
] as const;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set<string>(RESERVED);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

export const ALIAS_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

export type AliasValidation = { ok: true } | { ok: false; code: 'alias_format' | 'alias_reserved' };

export function validateAlias(alias: string): AliasValidation {
  if (!ALIAS_REGEX.test(alias)) return { ok: false, code: 'alias_format' };
  if (isReservedSlug(alias)) return { ok: false, code: 'alias_reserved' };
  return { ok: true };
}
