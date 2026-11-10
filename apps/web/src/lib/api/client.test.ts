import { describe, expect, it, vi } from 'vitest';
import { ApiClient, type SessionEvent } from './client';
import { ApiError } from './problem';

const session = (token: string) => ({
  access_token: token,
  token_type: 'Bearer',
  expires_in: 900,
  user: { id: 1, email: 'demo@encurta.dev', created_at: '2026-11-09T00:00:00Z' },
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  type: `https://encurta.dev/problems/${code}`,
  title: code,
  status,
  code,
  ...extra,
});

/** Servidor falso: o token válido é `t<n>`; cada refresh com o cookie atual gira para o próximo. */
function fakeServer() {
  let valid = 't0';
  let cookie = 'c0';
  const refreshes: string[] = [];
  const revokedFamilies: string[] = [];
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    seen.push({ url, headers });
    // Um pouco de latência para as requisições se cruzarem de verdade.
    await new Promise((r) => setTimeout(r, 5));
    if (url.endsWith('/v1/auth/refresh')) {
      refreshes.push(cookie);
      if (cookie === 'revoked') return json(401, problem(401, 'invalid_refresh'));
      const n = Number(valid.slice(1)) + 1;
      valid = `t${n}`;
      cookie = `c${n}`;
      return json(200, session(valid));
    }
    if (headers.authorization !== `Bearer ${valid}`) {
      return json(401, problem(401, 'unauthorized'));
    }
    if (url.includes('/v1/links?')) {
      if (headers['if-none-match'] === 'W/"abc"') return new Response(null, { status: 304 });
      return json(200, { data: [{ id: 1 }] }, { etag: 'W/"abc"' });
    }
    return json(200, { ok: true, auth: headers.authorization, key: headers['idempotency-key'] });
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    expire: () => {
      valid = `t${Number(valid.slice(1)) + 100}`;
    },
    revoke: () => {
      cookie = 'revoked';
      revokedFamilies.push('f');
    },
    refreshes,
    seen,
    get token() {
      return valid;
    },
  };
}

/** Web Lock falso (fila FIFO) e BroadcastChannel falso, compartilhados entre "abas". */
function fakeTabs() {
  let tail: Promise<unknown> = Promise.resolve();
  const locks = {
    request<T>(_name: string, cb: () => Promise<T>): Promise<T> {
      const run = tail.then(cb, cb);
      tail = run.catch(() => undefined);
      return run;
    },
  };
  const members = new Set<{ fn: (ev: MessageEvent) => void }>();
  const channel = () => {
    const self: { fn: (ev: MessageEvent) => void } = { fn: () => {} };
    members.add(self);
    return {
      postMessage(data: unknown) {
        for (const m of members) if (m !== self) m.fn({ data } as MessageEvent);
      },
      addEventListener(_t: 'message', fn: (ev: MessageEvent) => void) {
        self.fn = fn;
      },
      close() {
        members.delete(self);
      },
    };
  };
  return { locks, channel };
}

describe('ApiClient: refresh único', () => {
  it('três 401 simultâneos disparam um refresh só, e as três requisições são repetidas', async () => {
    const server = fakeServer();
    const api = new ApiClient({ baseUrl: '/api', fetch: server.fetch, locks: null, channel: null });
    api.startSession(session('t0') as never);
    server.expire();

    const results = await Promise.all([
      api.get<{ ok: boolean }>('/v1/me'),
      api.get<{ ok: boolean }>('/v1/overview'),
      api.post<{ ok: boolean }>('/v1/live/ticket'),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(server.refreshes).toHaveLength(1);
    expect(api.accessToken).toBe(server.token);
  });

  it('o refresh manda o cabeçalho anti-CSRF e a repetição reaproveita a Idempotency-Key', async () => {
    const server = fakeServer();
    const api = new ApiClient({ baseUrl: '/api', fetch: server.fetch, locks: null, channel: null });
    api.startSession(session('t0') as never);
    server.expire();
    const r = await api.post<{ key: string }>(
      '/v1/links',
      { destination: 'https://a.com' },
      { headers: { 'idempotency-key': 'tentativa-1' } },
    );
    expect(r.key).toBe('tentativa-1');
    const refresh = server.seen.find((s) => s.url.endsWith('/auth/refresh'))!;
    expect(refresh.headers['x-requested-with']).toBe('encurtador');
    const posts = server.seen.filter((s) => s.url.endsWith('/v1/links'));
    expect(posts.map((p) => p.headers['idempotency-key'])).toEqual(['tentativa-1', 'tentativa-1']);
  });

  it('duas abas com 401 ao mesmo tempo renovam uma vez só (Web Lock + BroadcastChannel)', async () => {
    const server = fakeServer();
    const tabs = fakeTabs();
    const a = new ApiClient({
      baseUrl: '/api',
      fetch: server.fetch,
      locks: tabs.locks,
      channel: tabs.channel(),
    });
    const b = new ApiClient({
      baseUrl: '/api',
      fetch: server.fetch,
      locks: tabs.locks,
      channel: tabs.channel(),
    });
    a.startSession(session('t0') as never);
    expect(b.accessToken).toBe('t0'); // a aba nova recebeu a sessão pelo canal
    server.expire();

    const [ra, rb] = await Promise.all([
      a.get<{ ok: boolean }>('/v1/me'),
      b.get<{ ok: boolean }>('/v1/me'),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    // Uma rotação só: a segunda aba esperou o lock e usou o token que a primeira anunciou.
    expect(server.refreshes).toEqual(['c0']);
    expect(a.accessToken).toBe(b.accessToken);
  });

  it('sem refresh válido, encerra a sessão como expirada e lança 401 em pt-BR', async () => {
    const server = fakeServer();
    const api = new ApiClient({ baseUrl: '/api', fetch: server.fetch, locks: null, channel: null });
    const events: SessionEvent[] = [];
    api.onSession((e) => events.push(e));
    api.startSession(session('t0') as never);
    server.expire();
    server.revoke();
    const err = await api.get('/v1/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toBe('Sua sessão expirou. Entre de novo para continuar.');
    expect(events.at(-1)).toEqual({ type: 'ended', reason: 'expired' });
    expect(api.accessToken).toBeNull();
  });

  it('sem sessão anterior, o primeiro refresh que falha é "visitante", não "expirou"', async () => {
    const server = fakeServer();
    server.revoke();
    const api = new ApiClient({ baseUrl: '/api', fetch: server.fetch, locks: null, channel: null });
    const events: SessionEvent[] = [];
    api.onSession((e) => events.push(e));
    expect(await api.refresh(null)).toBeNull();
    expect(events).toEqual([{ type: 'ended', reason: 'anonymous' }]);
  });
});

describe('ApiClient: ETag', () => {
  it('manda If-None-Match e devolve o corpo guardado no 304', async () => {
    const server = fakeServer();
    const api = new ApiClient({ baseUrl: '/api', fetch: server.fetch, locks: null, channel: null });
    api.startSession(session('t0') as never);
    const first = await api.request('GET', '/v1/links', { query: { limit: 20 } });
    const second = await api.request('GET', '/v1/links', { query: { limit: 20 } });
    expect(first.status).toBe(200);
    expect(second.status).toBe(304);
    expect(second.data).toEqual({ data: [{ id: 1 }] });
    const gets = server.seen.filter((s) => s.url.includes('/v1/links?'));
    expect(gets[1]!.headers['if-none-match']).toBe('W/"abc"');
  });
});

describe('ApiClient: problem+json', () => {
  it('429 vira a frase com o Retry-After', async () => {
    const fetch = vi.fn(async () =>
      json(429, problem(429, 'rate_limited'), { 'retry-after': '40' }),
    ) as unknown as typeof globalThis.fetch;
    const api = new ApiClient({ baseUrl: '', fetch, locks: null, channel: null });
    const err = (await api
      .post('/v1/public/links', {}, { auth: false })
      .catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(40);
    expect(err.message).toBe('Muitas tentativas seguidas. Tente de novo em 40 s.');
  });

  it('falha de rede vira status 0 com mensagem própria', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    const api = new ApiClient({ baseUrl: '', fetch, locks: null, channel: null });
    const err = (await api.get('/v1/x', { auth: false }).catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.message).toContain('Sem conexão');
  });
});
