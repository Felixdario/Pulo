import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isPublicIp, parseIpv4, parseIpv6, validateDestination } from '@encurtador/shared';

/**
 * Buscador seguro contra SSRF (ADR 0004):
 * - resolve o DNS uma vez por salto, recusa se **qualquer** endereço não for público e conecta no
 *   IP resolvido (fixado via `lookup`), então um DNS que muda entre a checagem e a conexão (rebinding)
 *   não leva a outro lugar;
 * - no máximo `maxRedirects` redirecionamentos, cada destino revalidado (esquema, credenciais,
 *   loop, DNS);
 * - prazo total, só `text/html` e no máximo `maxBytes` lidos (já descomprimidos).
 *
 * O resolvedor e a política de IP são injetáveis: os testes apontam nomes falsos para um servidor
 * local e, sem trocar a política, provam que 127.0.0.1 é recusado.
 */

export type Resolver = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

export type PreviewErrorCode =
  | 'invalid_url'
  | 'private_address'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'timeout'
  | 'not_html'
  | 'http_error'
  | 'fetch_failed';

export class PreviewError extends Error {
  override readonly name = 'PreviewError';
  constructor(
    readonly code: PreviewErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface FetcherOptions {
  shortDomains: readonly string[];
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  resolve?: Resolver;
  isAllowedAddress?: (ip: string) => boolean;
  userAgent?: string;
}

export interface FetchedPage {
  finalUrl: string;
  redirects: number;
  contentType: string;
  html: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function charsetOf(contentType: string): BufferEncoding {
  const m = /charset=["']?([\w-]+)/i.exec(contentType);
  const c = m?.[1]?.toLowerCase();
  return c === 'iso-8859-1' || c === 'latin1' || c === 'windows-1252' ? 'latin1' : 'utf8';
}

export function createFetcher(opts: FetcherOptions) {
  const resolve = opts.resolve ?? systemResolver;
  const allowed = opts.isAllowedAddress ?? isPublicIp;

  async function pin(url: URL): Promise<{ address: string; family: 4 | 6 }> {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (parseIpv4(host) !== null || parseIpv6(host) !== null) {
      if (!allowed(host)) throw new PreviewError('private_address', 'endereço não público');
      return { address: host, family: host.includes(':') ? 6 : 4 };
    }
    let addrs: { address: string; family: 4 | 6 }[];
    try {
      addrs = await resolve(host);
    } catch {
      throw new PreviewError('dns_failed', `não resolveu ${host}`);
    }
    if (addrs.length === 0) throw new PreviewError('dns_failed', `não resolveu ${host}`);
    if (addrs.some((a) => !allowed(a.address))) {
      throw new PreviewError('private_address', `${host} resolve para endereço não público`);
    }
    return addrs[0]!;
  }

  function request(url: URL, ip: { address: string; family: 4 | 6 }, signal: AbortSignal) {
    const lookup: LookupFunction = (_host, options, cb) => {
      if ((options as { all?: boolean }).all) {
        (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [ip]);
      } else cb(null, ip.address, ip.family);
    };
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise<IncomingMessage>((resolveRes, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          lookup,
          agent: false,
          signal,
          ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
          headers: {
            'user-agent': opts.userAgent ?? 'EncurtadorPreview/1.0 (+https://encurta.dev)',
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
            'accept-encoding': 'gzip, deflate, br',
          },
        },
        resolveRes,
      );
      req.on('error', reject);
      req.end();
    });
  }

  async function readBody(res: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
    const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
    const stream =
      enc === 'gzip'
        ? res.pipe(createGunzip())
        : enc === 'deflate'
          ? res.pipe(createInflate())
          : enc === 'br'
            ? res.pipe(createBrotliDecompress())
            : res;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (signal.aborted) break;
        const room = opts.maxBytes - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += Math.min(chunk.length, room);
        if (size >= opts.maxBytes) break;
      }
    } catch (err) {
      if (chunks.length === 0) throw err;
    } finally {
      res.destroy();
    }
    return Buffer.concat(chunks);
  }

  /** Busca a página seguindo até `maxRedirects` redirecionamentos validados. */
  return async function fetchPage(rawUrl: string): Promise<FetchedPage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      let current = rawUrl;
      for (let redirects = 0; ; redirects++) {
        const v = validateDestination(current, { shortDomains: opts.shortDomains });
        if (!v.ok) {
          throw new PreviewError(
            v.code === 'private_host' ? 'private_address' : 'invalid_url',
            v.code,
          );
        }
        const url = new URL(v.url);
        const ip = await pin(url);
        let res: IncomingMessage;
        try {
          res = await request(url, ip, controller.signal);
        } catch (err) {
          if (controller.signal.aborted) throw new PreviewError('timeout', 'tempo esgotado');
          throw new PreviewError('fetch_failed', (err as Error).message);
        }
        const status = res.statusCode ?? 0;
        if (REDIRECTS.has(status) && res.headers.location) {
          res.resume();
          if (redirects >= opts.maxRedirects) {
            throw new PreviewError(
              'too_many_redirects',
              `mais de ${opts.maxRedirects} redirecionamentos`,
            );
          }
          current = new URL(res.headers.location, url).href;
          continue;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          throw new PreviewError('http_error', `o destino respondeu ${status}`);
        }
        const contentType = String(res.headers['content-type'] ?? '');
        if (!/^\s*(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
          res.destroy();
          throw new PreviewError('not_html', `conteúdo ${contentType || 'sem tipo'}, não HTML`);
        }
        let body: Buffer;
        try {
          body = await readBody(res, controller.signal);
        } catch (err) {
          if (controller.signal.aborted) throw new PreviewError('timeout', 'tempo esgotado');
          throw new PreviewError('fetch_failed', (err as Error).message);
        }
        if (controller.signal.aborted && body.length === 0) {
          throw new PreviewError('timeout', 'tempo esgotado');
        }
        return {
          finalUrl: url.href,
          redirects,
          contentType,
          html: body.toString(charsetOf(contentType)),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
