import { createHmac, timingSafeEqual } from 'node:crypto';

export const UNLOCK_TTL_SECONDS = 3600;
export const unlockCookieName = (slug: string) => `__unlock_${slug}`;

/**
 * Valor do cookie de desbloqueio: `<exp>.<hmac>`. O HMAC cobre slug, id do link, versão da senha e
 * expiração: trocar a senha invalida os cookies antigos, e um cookie não vale para outro link.
 */
function sign(secret: string, slug: string, linkId: number, pv: string, exp: number): string {
  return createHmac('sha256', secret)
    .update(`unlock|${slug}|${linkId}|${pv}|${exp}`)
    .digest('base64url');
}

export function makeUnlockCookie(
  secret: string,
  link: { slug: string; id: number; passwordVersion: string },
  secure: boolean,
  now = Date.now(),
): string {
  const exp = Math.floor(now / 1000) + UNLOCK_TTL_SECONDS;
  const value = `${exp}.${sign(secret, link.slug, link.id, link.passwordVersion, exp)}`;
  return [
    `${unlockCookieName(link.slug)}=${value}`,
    `Max-Age=${UNLOCK_TTL_SECONDS}`,
    `Path=/${link.slug}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function hasValidUnlock(
  secret: string,
  cookieHeader: string | undefined,
  link: { slug: string; id: number; passwordVersion: string },
  now = Date.now(),
): boolean {
  const value = readCookie(cookieHeader, unlockCookieName(link.slug));
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot === -1) return false;
  const exp = Number(value.slice(0, dot));
  if (!Number.isInteger(exp) || exp * 1000 <= now) return false;
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(secret, link.slug, link.id, link.passwordVersion, exp));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
