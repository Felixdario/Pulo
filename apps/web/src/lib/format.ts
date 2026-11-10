/** Números e datas no jeito brasileiro (DESIGN.md > Data Patterns). */

const nf = new Intl.NumberFormat('pt-BR');
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

export const num = (n: number) => nf.format(n);
export const numCompact = (n: number) => compact.format(n);
/** `91 %`, com espaço, como no DESIGN.md. */
export const percent = (share: number) => `${pct.format(share * 100)} %`;

const shortDate = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' });
const longDate = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fullDateTime = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** `12 nov.` */
export const dateShort = (iso: string | Date) => shortDate.format(new Date(iso));
/** `9 de dezembro de 2026` */
export const dateLong = (iso: string | Date) => longDate.format(new Date(iso));
/** `12/12 23:59` */
export const dateTimeShort = (iso: string | Date) =>
  dateTime.format(new Date(iso)).replace(',', '');
export const timeOnly = (iso: string | Date) => time.format(new Date(iso));
export const dateTimeLong = (iso: string | Date) => fullDateTime.format(new Date(iso));

/** "há 3 min", "há 2 dias" — para "último uso". */
export function relative(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  if (s < 60) return 'agora há pouco';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86_400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 30 * 86_400) return rtf.format(-Math.round(s / 86_400), 'day');
  return dateShort(iso);
}

/** `localhost:8080/` + `aB3xK9q`: domínio e slug separados para o desenho do link curto. */
export function splitShortUrl(shortUrl: string): { host: string; slug: string } {
  try {
    const u = new URL(shortUrl);
    return { host: `${u.host}/`, slug: u.pathname.replace(/^\//, '') };
  } catch {
    return { host: '', slug: shortUrl };
  }
}

/** Host sem `www.`, para o destino. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Corta no meio: `loja.com.br/…/natal`. */
export function middleTruncate(s: string, max = 48): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Destino sem protocolo, para leitura. */
export function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Lê o slug caractere por caractere para o leitor de tela (DESIGN.md > Accessibility). */
export function spellSlug(host: string, slug: string): string {
  const h = host.replace(/\/$/, '').replace(/\./g, ' ponto ').replace(/:/g, ' dois pontos ');
  // Alias legível (`black-friday`) é lido como palavra; slug aleatório (`aB3xK9q`), letra a letra.
  const readable = /^[a-z]+([_-][a-z0-9]+)*$/.test(slug);
  return `${h} barra ${readable ? slug.replace(/[-_]/g, ' ') : slug.split('').join(' ')}`;
}
