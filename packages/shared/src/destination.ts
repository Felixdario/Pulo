import { classifyIp, parseIpv4 } from './ip';

export const MAX_DESTINATION_LENGTH = 4096;

export type DestinationErrorCode =
  'invalid_url' | 'too_long' | 'unsupported_protocol' | 'credentials' | 'private_host' | 'loop';

export type DestinationValidation =
  { ok: true; url: string } | { ok: false; code: DestinationErrorCode };

export interface DestinationOptions {
  /**
   * Domínios curtos do próprio serviço (ex.: `enc.ta`). Destino neles ou em subdomínio = loop.
   * Só o nome do host: sem esquema, porta, caminho ou credenciais. Entrada inválida lança
   * `TypeError` (erro de configuração, não de dado do usuário).
   */
  shortDomains: readonly string[];
}

/**
 * Nomes locais, comparados sem o ponto final. Hosts de um rótulo só (sem ponto) já caem antes, pela
 * regra geral; a lista explícita documenta os de /etc/hosts.
 */
const LOCAL_NAMES = [
  'localhost',
  'localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'ip6-localnet',
  'ip6-allnodes',
  'ip6-allrouters',
  'ip6-mcastprefix',
];
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

const fail = (code: DestinationErrorCode): DestinationValidation => ({ ok: false, code });

/** Hostname em minúsculas, punycode (via WHATWG), sem pontos finais e sem `www.` inicial. */
function comparableHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/^www\./, '');
}

/**
 * Normaliza a lista de domínios curtos (caixa, IDN → punycode, ponto final, `www.`). Lança
 * `TypeError` para qualquer entrada que não seja um nome de host com ponto: vazio, com esquema,
 * porta, caminho, query, fragmento, credenciais, IP literal ou que o WHATWG recuse. Assim um erro de
 * configuração nunca desliga a proteção de loop em silêncio. Chamada por `validateDestination`;
 * pode ser chamada uma vez na inicialização para falhar cedo.
 */
export function normalizeShortDomains(domains: readonly string[]): string[] {
  if (!Array.isArray(domains)) throw new TypeError('shortDomains precisa ser uma lista');
  return domains.map((domain) => {
    if (typeof domain !== 'string') {
      throw new TypeError(`shortDomain inválido: ${String(domain)}`);
    }
    const d = domain.trim();
    if (d === '' || /[/\\?#@:\s]/.test(d)) {
      throw new TypeError(
        `shortDomain inválido (só o host, sem esquema/porta/caminho): "${domain}"`,
      );
    }
    let hostname: string;
    try {
      hostname = new URL(`http://${d}/`).hostname;
    } catch {
      throw new TypeError(`shortDomain inválido: "${domain}"`);
    }
    const host = comparableHost(hostname);
    if (hostname.startsWith('[') || parseIpv4(hostname) !== null || !host.includes('.')) {
      throw new TypeError(`shortDomain precisa ser um nome de domínio com ponto: "${domain}"`);
    }
    if (!/^[a-z0-9.-]+$/.test(host) || host.split('.').some((label) => label === '')) {
      throw new TypeError(`shortDomain inválido: "${domain}"`);
    }
    return host;
  });
}

/**
 * Valida o destino de um link (ADR 0002, seção 3) e devolve a URL normalizada pelo parser WHATWG.
 * Lista de permissão: só http/https. Não faz DNS; hostnames que resolvem para IP privado são
 * tratados no buscador seguro.
 */
export function validateDestination(
  raw: string,
  { shortDomains }: DestinationOptions,
): DestinationValidation {
  const shorts = normalizeShortDomains(shortDomains);

  if (typeof raw !== 'string') return fail('invalid_url');
  if (raw.length > MAX_DESTINATION_LENGTH) return fail('too_long');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('invalid_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('unsupported_protocol');
  if (url.username !== '' || url.password !== '') return fail('credentials');

  const hostname = url.hostname;
  if (hostname === '') return fail('invalid_url');

  if (hostname.startsWith('[') || parseIpv4(hostname) !== null) {
    // O WHATWG já converteu 2130706433, 0x7f.1, 0177.0.0.1, 127.1 e ::ffff:127.0.0.1 para a
    // forma canônica; aqui só sobra classificar.
    if (classifyIp(hostname) !== 'public') return fail('private_host');
  } else {
    const name = hostname.toLowerCase().replace(/\.+$/, '');
    if (name === '') return fail('invalid_url');
    // Um rótulo só (`router`, `metadata`, `intranet`) resolve pelo domínio de busca local.
    if (!name.includes('.')) return fail('private_host');
    if (LOCAL_NAMES.includes(name) || LOCAL_SUFFIXES.some((s) => name.endsWith(s))) {
      return fail('private_host');
    }
    const host = comparableHost(hostname);
    for (const short of shorts) {
      if (host === short || host.endsWith(`.${short}`)) return fail('loop');
    }
  }

  const normalized = url.href;
  if (normalized.length > MAX_DESTINATION_LENGTH) return fail('too_long');
  return { ok: true, url: normalized };
}
