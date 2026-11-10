/** Números e datas no jeito brasileiro (DESIGN.md > Data Patterns). */

const nf = new Intl.NumberFormat('pt-BR');
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

export const num = (n: number) => nf.format(n);
export const numCompact = (n: number) => compact.format(n);
/** `91 %`, com espaço, como no DESIGN.md. */
export const percent = (share: number) => `${pct.format(share * 100)} %`;

const shortDate = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' });
const shortDateYear = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
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

/**
 * `12 nov.`; fora do ano corrente, `12 de nov. de 2025`. Sem o ano, o período de 12 meses lia "de 1 de
 * dez. a 10 de nov.", e a lista misturava links de dois anos com a mesma data (break-ui).
 */
export const dateShort = (iso: string | Date, now = new Date()) => {
  const d = new Date(iso);
  return (d.getFullYear() === now.getFullYear() ? shortDate : shortDateYear).format(d);
};
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

/**
 * Punycode → Unicode (RFC 3492, só a decodificação) para mostrar domínios como `ação.com.br`. A API
 * guarda o destino normalizado pelo parser WHATWG, que troca o host por `xn--ao-lja.com.br`.
 */
function punyDecode(label: string): string {
  const base = 36;
  const out: number[] = [];
  const dash = label.lastIndexOf('-');
  for (let j = 0; j < Math.max(0, dash); j++) out.push(label.charCodeAt(j));
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let k = dash > 0 ? dash + 1 : 0; k < label.length;) {
    const old = i;
    for (let w = 1, t = base; ; t += base) {
      if (k >= label.length) throw new RangeError('punycode');
      const c = label.charCodeAt(k++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
      if (digit >= base) throw new RangeError('punycode');
      i += digit * w;
      const th = t <= bias ? 1 : t >= bias + 26 ? 26 : t - bias;
      if (digit < th) break;
      w *= base - th;
    }
    const len = out.length + 1;
    let delta = old === 0 ? Math.floor((i - old) / 700) : (i - old) >> 1;
    delta += Math.floor(delta / len);
    let kk = 0;
    for (; delta > 455; kk += base) delta = Math.floor(delta / 35);
    bias = Math.floor(kk + (36 * delta) / (delta + 38));
    n += Math.floor(i / len);
    i %= len;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** Host para leitura: Unicode no lugar do punycode. Se algo não decodificar, fica como veio. */
export function displayHost(host: string): string {
  return host
    .split('.')
    .map((l) => {
      if (!/^xn--/i.test(l)) return l;
      try {
        return punyDecode(l.slice(4).toLowerCase());
      } catch {
        return l;
      }
    })
    .join('.');
}

/** Host sem `www.`, para o destino. */
export function hostOf(url: string): string {
  try {
    return displayHost(new URL(url).host.replace(/^www\./, ''));
  } catch {
    return url;
  }
}

/** Graphemes (emoji com ZWJ e bandeiras contam como um só), para cortar sem partir um caractere. */
function graphemes(s: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return Array.from(
      new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }).segment(s),
      (x) => x.segment,
    );
  }
  return Array.from(s);
}

/** Corta no meio: `loja.com.br/…/natal`. Conta graphemes, não unidades UTF-16. */
export function middleTruncate(s: string, max = 48): string {
  const g = graphemes(s);
  if (g.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${g.slice(0, head).join('')}…${g.slice(g.length - tail).join('')}`;
}

/** Destino sem protocolo, para leitura: domínio em Unicode e caminho com os acentos decodificados. */
export function prettyUrl(url: string): string {
  const m = /^(https?:\/\/)?([^/?#]*)(.*)$/i.exec(url);
  const host = displayHost(m?.[2] ?? '');
  let rest = m?.[3] ?? '';
  try {
    rest = decodeURI(rest);
  } catch {
    /* sequência % inválida: fica codificada */
  }
  return `${host}${rest}`.replace(/\/$/, '');
}

/** Lê o slug caractere por caractere para o leitor de tela (DESIGN.md > Accessibility). */
export function spellSlug(host: string, slug: string): string {
  const h = host.replace(/\/$/, '').replace(/\./g, ' ponto ').replace(/:/g, ' dois pontos ');
  // Alias legível (`black-friday`) é lido como palavra; slug aleatório (`aB3xK9q`), letra a letra.
  const readable = /^[a-z]+([_-][a-z0-9]+)*$/.test(slug);
  return `${h} barra ${readable ? slug.replace(/[-_]/g, ' ') : slug.split('').join(' ')}`;
}
