import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isPublicIp } from '@encurtador/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Resolver } from '../../src/modules/preview/fetcher';
import { expectProblem, setup, signup } from './helpers';

const t = setup();
let server: http.Server;
let port = 0;
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    const url = req.url ?? '/';
    const hop = /^\/r(\d+)$/.exec(url);
    if (hop) {
      const n = Number(hop[1]);
      res.writeHead(302, { location: n > 1 ? `/r${n - 1}` : '/page' }).end();
    } else if (url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<html><head><title>Página</title><meta property="og:title" content="Título OG">
         <meta property="og:description" content="Descrição &amp; mais"><meta property="og:image" content="/og.png">
         </head><body>${'x'.repeat(10)}</body></html>`,
      );
    } else if (url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } else if (url === '/to-private') {
      res.writeHead(302, { location: `http://evil.example:${port}/page` }).end();
    } else if (url === '/huge') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><head><title>Grande</title></head><body>');
      const chunk = 'y'.repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 4 * 1024 * 1024 && res.write(chunk)) sent += chunk.length;
        if (sent < 4 * 1024 * 1024) res.once('drain', pump);
        else res.end();
      };
      pump();
    } else if (url === '/slow') {
      setTimeout(
        () => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>tarde</title>'),
        2000,
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

beforeEach(async () => {
  hits.length = 0;
  await t.reset();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await t.teardown();
});

/** DNS falso: os dois nomes apontam para o servidor local (127.0.0.1). */
const fakeDns: Resolver = async (host) => {
  if (host === 'site.example' || host === 'evil.example')
    return [{ address: '127.0.0.1', family: 4 }];
  throw new Error('ENOTFOUND');
};
/** Política de teste: só "site.example" é tratado como público, via um IP fixado conhecido. */
const testPolicy = (ip: string) => ip === '127.0.0.1' || isPublicIp(ip);

async function client(policy?: (ip: string) => boolean, overrides = {}) {
  const app = await t.app(overrides, {
    resolve: fakeDns,
    ...(policy ? { isAllowedAddress: policy } : {}),
  });
  const s = await signup(app);
  return (url: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/preview?url=${encodeURIComponent(url)}`,
      headers: s.auth,
    });
}

describe('GET /v1/preview', () => {
  it('recusa destino cujo DNS responde 127.0.0.1 (política de produção), sem conectar', async () => {
    const get = await client();
    const p = expectProblem(await get(`http://evil.example:${port}/page`), 422, 'preview_blocked');
    expect(p.reason).toBe('private_address');
    expect(hits).toEqual([]);
    // IP literal privado e nomes locais também.
    expectProblem(await get(`http://127.0.0.1:${port}/page`), 422, 'preview_blocked');
    expectProblem(await get('http://localhost/'), 422, 'preview_blocked');
    expectProblem(await get('ftp://site.example/'), 422, 'preview_blocked');
  });

  it('extrai título, descrição e imagem; segue até 3 redirecionamentos', async () => {
    const get = await client(testPolicy);
    const res = await get(`http://site.example:${port}/r3`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      final_url: `http://site.example:${port}/page`,
      redirects: 3,
      title: 'Título OG',
      description: 'Descrição & mais',
      image: `http://site.example:${port}/og.png`,
      favicon: `http://site.example:${port}/favicon.ico`,
    });
    expect(hits).toEqual(['/r3', '/r2', '/r1', '/page']);
  });

  it('4 redirecionamentos → erro, sem buscar o quarto destino', async () => {
    const get = await client(testPolicy);
    const p = expectProblem(await get(`http://site.example:${port}/r4`), 502, 'upstream_error');
    expect(p.reason).toBe('too_many_redirects');
    expect(hits).toEqual(['/r4', '/r3', '/r2', '/r1']);
  });

  it('revalida cada salto: redirecionar para um nome que resolve para IP privado é recusado', async () => {
    // site.example → 127.0.0.1 (permitido no teste); evil.example → 10.0.0.1 (privado).
    const strictDns = await t.app(
      {},
      {
        resolve: async (host) =>
          host === 'evil.example'
            ? [{ address: '10.0.0.1', family: 4 }]
            : [{ address: '127.0.0.1', family: 4 }],
        isAllowedAddress: (ip) => ip === '127.0.0.1',
      },
    );
    const s = await signup(strictDns);
    const res = await strictDns.inject({
      method: 'GET',
      url: `/v1/preview?url=${encodeURIComponent(`http://site.example:${port}/to-private`)}`,
      headers: s.auth,
    });
    expect(expectProblem(res, 422, 'preview_blocked').reason).toBe('private_address');
    expect(hits).toEqual(['/to-private']);
  });

  it('só text/html, lê no máximo 512 KB e respeita o timeout', async () => {
    const get = await client(testPolicy, {
      preview: { timeoutMs: 500, maxBytes: 512 * 1024, maxRedirects: 3, cacheTtlSeconds: 3600 },
    });
    expect(expectProblem(await get(`http://site.example:${port}/json`), 502).reason).toBe(
      'not_html',
    );
    const huge = await get(`http://site.example:${port}/huge`);
    expect(huge.statusCode).toBe(200);
    expect(huge.json().title).toBe('Grande');
    expect(expectProblem(await get(`http://site.example:${port}/slow`), 502).reason).toBe(
      'timeout',
    );
  });

  it('cacheia por 1 h no Redis', async () => {
    const get = await client(testPolicy);
    await get(`http://site.example:${port}/page`);
    await get(`http://site.example:${port}/page`);
    expect(hits).toEqual(['/page']);
    const keys = await t.redis.keys('pv:*');
    expect(keys).toHaveLength(1);
    expect(await t.redis.ttl(keys[0]!)).toBeGreaterThan(3500);
  });
});
