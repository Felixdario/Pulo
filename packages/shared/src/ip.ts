/**
 * Classificação de endereços IP literais (v4 e v6). Só `public` pode ser destino de um link; o
 * redirect e o worker usam a mesma função para decidir o que é IP de visitante válido.
 *
 * Aceita IPv4 em notação decimal canônica (`a.b.c.d`, sem zeros à esquerda) e IPv6 em qualquer
 * grafia RFC 4291 (com ou sem colchetes, com `::`, com IPv4 no fim, com zona `%eth0`). Formas
 * exóticas de IPv4 (`2130706433`, `0x7f.1`, `0177.0.0.1`) não são IP aqui: o parser WHATWG de URL é
 * que as normaliza antes, em `validateDestination`.
 */
export type IpKind =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link_local'
  | 'cgnat'
  | 'unique_local'
  | 'multicast'
  | 'unspecified'
  | 'broadcast'
  | 'benchmark'
  | 'documentation'
  | 'reserved'
  | 'invalid';

type V4Range = readonly [base: string, prefix: number, kind: Exclude<IpKind, 'public' | 'invalid'>];

// Ordem importa: o primeiro que casar vence (broadcast antes de 240/4).
const V4_RANGES: readonly V4Range[] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link_local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['255.255.255.255', 32, 'broadcast'],
  ['240.0.0.0', 4, 'reserved'],
];

const V4_DOTTED = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** IPv4 decimal canônico → inteiro sem sinal, ou `null`. */
export function parseIpv4(ip: string): number | null {
  if (!V4_DOTTED.test(ip)) return null;
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

const mask = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

const V4_TABLE = V4_RANGES.map(([base, prefix, kind]) => ({
  base: parseIpv4(base)!,
  mask: mask(prefix),
  kind,
}));

function classifyV4Int(value: number): IpKind {
  for (const range of V4_TABLE) {
    if ((value & range.mask) >>> 0 === range.base) return range.kind;
  }
  return 'public';
}

/** IPv6 → 8 palavras de 16 bits, ou `null`. Aceita colchetes e zona. */
export function parseIpv6(input: string): number[] | null {
  let ip = input;
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) {
    if (zone === ip.length - 1) return null;
    ip = ip.slice(0, zone);
  }
  if (!ip.includes(':')) return null;

  // IPv4 embutido nas últimas 32 bits.
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(':');
  const lastPart = ip.slice(lastColon + 1);
  if (lastPart.includes('.')) {
    const v4 = parseIpv4(lastPart);
    if (v4 === null) return null;
    tail = [v4 >>> 16, v4 & 0xffff];
    // "a::1.2.3.4" → "a::"; "a:b:c:d:e:f:1.2.3.4" → "a:b:c:d:e:f".
    ip = ip.slice(0, lastColon + 1);
    if (!ip.endsWith('::')) ip = ip.slice(0, -1);
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const groups = s.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]!);
  if (head === null) return null;
  const needed = 8 - tail.length;
  let words: number[];
  if (halves.length === 2) {
    const rest = parseGroups(halves[1]!);
    if (rest === null) return null;
    const zeros = needed - head.length - rest.length;
    if (zeros < 1) return null;
    words = [...head, ...new Array<number>(zeros).fill(0), ...rest];
  } else {
    if (head.length !== needed) return null;
    words = head;
  }
  return [...words, ...tail];
}

function classifyV6(w: number[]): IpKind {
  const [w0, w1, w2, w3, w4, w5, w6, w7] = w as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const v4 = (hi: number, lo: number) => classifyV4Int(((hi << 16) >>> 0) + lo);
  const firstSixZero = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0;

  if (firstSixZero && w6 === 0 && w7 === 0) return 'unspecified';
  if (firstSixZero && w6 === 0 && w7 === 1) return 'loopback';
  // ::ffff:a.b.c.d (mapeado) e ::ffff:0:a.b.c.d (SIIT): vale o IPv4 embutido.
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) return v4(w6, w7);
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff && w5 === 0) return v4(w6, w7);
  // ::a.b.c.d (compatível, obsoleto): nunca roteável.
  if (firstSixZero) return 'reserved';
  // NAT64 bem-conhecido 64:ff9b::/96: vale o IPv4 embutido. 64:ff9b:1::/48 é de uso local.
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return v4(w6, w7);
  }
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 1) return 'private';
  if (w0 === 0x100 && w1 === 0 && w2 === 0 && w3 === 0) return 'reserved'; // descarte 100::/64
  if (w0 === 0x2001 && w1 === 0x0db8) return 'documentation';
  if (w0 === 0x2001 && w1 === 0x0002 && w2 === 0) return 'benchmark';
  if (w0 === 0x2001 && w1 < 0x0200) return 'reserved'; // 2001::/23, inclui Teredo 2001::/32
  if (w0 === 0x2002) return v4(w1, w2); // 6to4
  if ((w0 & 0xfff0) === 0x3ff0) return 'documentation'; // 3fff::/20
  if (w0 === 0x5f00) return 'reserved'; // SRv6
  if ((w0 & 0xfe00) === 0xfc00) return 'unique_local';
  if ((w0 & 0xffc0) === 0xfe80) return 'link_local';
  if ((w0 & 0xffc0) === 0xfec0) return 'private'; // site-local, obsoleto
  if ((w0 & 0xff00) === 0xff00) return 'multicast';
  if ((w0 & 0xe000) === 0x2000) return 'public'; // 2000::/3, unicast global
  return 'reserved';
}

export function classifyIp(ip: string): IpKind {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return classifyV4Int(v4);
  const v6 = parseIpv6(ip);
  if (v6 !== null) return classifyV6(v6);
  return 'invalid';
}

export function isPublicIp(ip: string): boolean {
  return classifyIp(ip) === 'public';
}

/** Se o IPv6 é IPv4 mapeado (`::ffff:a.b.c.d`), devolve o IPv4 como inteiro. */
function mappedV4(words: number[]): number | null {
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return ((w6! << 16) >>> 0) + w7!;
  }
  return null;
}

const v4ToString = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Forma comprimida canônica (RFC 5952) de 8 palavras. */
function v6ToString(words: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = words.map((w) => w.toString(16));
  if (bestStart === -1) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/**
 * IP truncado para geolocalização (ADR 0003): /24 em IPv4 (`203.0.113.0`), /48 em IPv6
 * (`2001:db8:abcd::`). IPv4 mapeado em IPv6 é tratado como IPv4. Devolve só o endereço de rede, sem
 * o prefixo; `null` se não for IP.
 */
export function truncateIp(ip: string): string | null {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return v4ToString((v4 & 0xffffff00) >>> 0);
  const v6 = parseIpv6(ip);
  if (v6 === null) return null;
  const mapped = mappedV4(v6);
  if (mapped !== null) return v4ToString((mapped & 0xffffff00) >>> 0);
  return v6ToString([v6[0]!, v6[1]!, v6[2]!, 0, 0, 0, 0, 0]);
}

/**
 * Compila uma lista de IPs/CIDRs (`10.0.0.0/8, 127.0.0.1, ::1/128`) num teste de pertinência. IPv4
 * mapeado em IPv6 casa com a regra IPv4. Entrada inválida lança `TypeError` (é configuração).
 */
export function compileCidrs(list: string | readonly string[]): (ip: string) => boolean {
  const items = (typeof list === 'string' ? list.split(',') : list)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const v4: { base: number; mask: number }[] = [];
  const v6: { words: number[]; prefix: number }[] = [];
  for (const item of items) {
    const [addr, prefixRaw] = item.split('/') as [string, string | undefined];
    const a4 = parseIpv4(addr);
    const a6 = a4 === null ? parseIpv6(addr) : null;
    if (a4 === null && a6 === null) throw new TypeError(`CIDR inválido: "${item}"`);
    const max = a4 !== null ? 32 : 128;
    const prefix = prefixRaw === undefined ? max : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || prefixRaw === '') {
      throw new TypeError(`CIDR inválido: "${item}"`);
    }
    if (a4 !== null) v4.push({ base: (a4 & mask(prefix)) >>> 0, mask: mask(prefix) });
    else v6.push({ words: a6!, prefix });
  }
  const inV6 = (w: number[], rule: { words: number[]; prefix: number }) => {
    let bits = rule.prefix;
    for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
      const m = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
      if ((w[i]! & m) !== (rule.words[i]! & m)) return false;
    }
    return true;
  };
  return (ip: string) => {
    let n = parseIpv4(ip);
    let w: number[] | null = null;
    if (n === null) {
      w = parseIpv6(ip);
      if (w === null) return false;
      n = mappedV4(w);
    }
    if (n !== null && v4.some((r) => (n! & r.mask) >>> 0 === r.base)) return true;
    return w !== null && v6.some((r) => inV6(w!, r));
  };
}
