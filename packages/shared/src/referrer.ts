import { parseIpv4 } from './ip';

export const DIRECT_REFERRER = '(direto)';
export const UNKNOWN_REFERRER = '(desconhecido)';
/** Referrer cujo host é um IP literal: o IP não é guardado nem como dimensão. */
export const IP_REFERRER = '(ip)';

/** Pacotes Android conhecidos que mandam `android-app://<pacote>` como Referer. */
const ANDROID_APPS: Record<string, string> = {
  'com.google.android.gm': 'gmail',
  'com.google.android.googlequicksearchbox': 'google',
  'com.google.android.apps.messaging': 'mensagens',
  'com.whatsapp': 'whatsapp',
  'com.slack': 'slack',
  'org.telegram.messenger': 'telegram',
  'com.linkedin.android': 'linkedin',
  'com.twitter.android': 'twitter',
  'com.facebook.katana': 'facebook',
  'com.facebook.orca': 'messenger',
  'com.instagram.android': 'instagram',
  'com.reddit.frontpage': 'reddit',
  'com.discord': 'discord',
  'com.microsoft.teams': 'teams',
};

/** Nome de pacote Android: rótulos `[a-z0-9_]` separados por ponto, ao menos dois. */
const PACKAGE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/**
 * Dimensão "referrer" (ADR 0003): só o domínio, minúsculo, sem `www.`; nada de caminho, query,
 * porta ou credenciais.
 * - ausente → `(direto)`;
 * - `android-app://<pacote>` → `app:<nome conhecido>` ou `app:<pacote>`, só se o pacote for um nome
 *   de pacote válido (sem userinfo, porta ou caracteres estranhos); senão `(desconhecido)`;
 * - host que é IP literal (v4 ou v6) → `(ip)`, para não guardar IP nem como valor de dimensão;
 * - o resto que não dá para interpretar (outros esquemas, lixo) → `(desconhecido)`.
 */
export function referrerDomain(ref: string | undefined | null): string {
  const raw = (ref ?? '').trim();
  if (raw === '') return DIRECT_REFERRER;

  const app = /^android-app:\/\/([^/?#]*)/i.exec(raw);
  if (app) {
    const pkg = app[1]!.toLowerCase();
    if (!PACKAGE.test(pkg) || pkg.length > 200) return UNKNOWN_REFERRER;
    return `app:${ANDROID_APPS[pkg] ?? pkg}`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return UNKNOWN_REFERRER;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return UNKNOWN_REFERRER;
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (hostname.startsWith('[') || parseIpv4(hostname) !== null) return IP_REFERRER;
  const host = hostname.replace(/^www\./, '');
  return host === '' ? UNKNOWN_REFERRER : host.slice(0, 253);
}
