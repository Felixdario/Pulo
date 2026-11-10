/** Metadados da prévia extraídos do HTML por expressões simples (sem DOM): só o `<head>` importa. */
export interface PageMeta {
  title: string | null;
  description: string | null;
  image: string | null;
  favicon: string | null;
  siteName: string | null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s: string | undefined, max: number) => {
  if (s === undefined) return null;
  const v = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return v === '' ? null : Array.from(v).slice(0, max).join('');
};

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function parseMeta(html: string, baseUrl: string): PageMeta {
  const head = html.slice(0, 256 * 1024);
  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? '').toLowerCase();
    if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
  }
  let icon: string | undefined;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
      icon ??= a.href;
      if (rel.includes('icon')) break;
    }
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  return {
    title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, 300),
    description: clean(
      meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'),
      500,
    ),
    image: absolute(meta.get('og:image') ?? meta.get('twitter:image'), baseUrl),
    favicon: absolute(icon ?? '/favicon.ico', baseUrl),
    siteName: clean(meta.get('og:site_name'), 200),
  };
}
