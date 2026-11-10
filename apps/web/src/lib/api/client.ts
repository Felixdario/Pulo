import { ApiError, type Problem } from './problem';
import type { Session } from './types';

/**
 * Cliente HTTP da API `/v1` (ADR 0004):
 * - o access token fica só em memória (nunca em storage);
 * - um 401 dispara UM refresh, compartilhado por todas as requisições da aba, e a requisição é
 *   repetida uma vez com o token novo;
 * - entre abas, o refresh roda sob um Web Lock: a rotação do refresh é estrita, e duas abas
 *   renovando ao mesmo tempo com o mesmo cookie revogariam a família inteira. Quem renovou avisa as
 *   outras abas por BroadcastChannel, e quem estava na fila do lock usa o token novo sem renovar;
 * - GETs guardam o corpo pelo ETag e mandam `If-None-Match`; um 304 devolve o corpo guardado;
 * - erro vira `ApiError`, com a mensagem em pt-BR mapeada do problem+json.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  headers?: Record<string, string>;
  /** `false` para rotas públicas e para o login: 401 não tenta refresh. */
  auth?: boolean;
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  etag: string | null;
  headers: Headers;
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export type SessionEvent =
  | { type: 'session'; session: Session; source: 'local' | 'remote' }
  | { type: 'ended'; reason: 'expired' | 'logout' | 'anonymous' };

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** `null` desliga a coordenação entre abas (testes, navegador sem Web Locks). */
  locks?: LockManagerLike | null;
  channel?: ChannelLike | null;
}

const CHANNEL = 'pulo-sessao';
const LOCK = 'pulo-refresh';
const CSRF = { 'x-requested-with': 'encurtador' };

function defaultLocks(): LockManagerLike | null {
  const nav = globalThis.navigator as Navigator | undefined;
  return nav?.locks ? (nav.locks as unknown as LockManagerLike) : null;
}

function defaultChannel(): ChannelLike | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
}

function buildUrl(base: string, path: string, query?: Query): string {
  let url = `${base}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  return url;
}

async function readProblem(res: Response): Promise<Problem | null> {
  const type = res.headers.get('content-type') ?? '';
  if (!/json/i.test(type)) return null;
  try {
    return (await res.json()) as Problem;
  } catch {
    return null;
  }
}

function retryAfterOf(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(1, Math.ceil(n));
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(1, Math.ceil((at - Date.now()) / 1000));
}

export class ApiClient {
  private token: string | null = null;
  private refreshing: Promise<string | null> | null = null;
  private readonly etags = new Map<string, { etag: string; body: unknown }>();
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly fetchImpl: typeof fetch;
  private readonly locks: LockManagerLike | null;
  private readonly channel: ChannelLike | null;
  /** Já houve sessão nesta aba: perder o refresh é "expirou", não "visitante". */
  private hadSession = false;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.locks = options.locks === undefined ? defaultLocks() : options.locks;
    this.channel = options.channel === undefined ? defaultChannel() : options.channel;
    this.channel?.addEventListener('message', (ev) => {
      const msg = ev.data as { type?: string; session?: Session } | null;
      if (msg?.type === 'session' && msg.session) {
        this.adopt(msg.session, 'remote');
      } else if (msg?.type === 'logout') {
        this.clear('logout', false);
      }
    });
  }

  get accessToken(): string | null {
    return this.token;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  onSession(fn: (e: SessionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SessionEvent) {
    for (const fn of this.listeners) fn(e);
  }

  private adopt(session: Session, source: 'local' | 'remote') {
    if (this.token === null || this.hadSession === false) this.etags.clear();
    this.token = session.access_token;
    this.hadSession = true;
    this.emit({ type: 'session', session, source });
  }

  private clear(reason: 'expired' | 'logout' | 'anonymous', broadcast: boolean) {
    this.token = null;
    this.etags.clear();
    if (broadcast && reason === 'logout') this.channel?.postMessage({ type: 'logout' });
    this.emit({ type: 'ended', reason });
  }

  /** Começa uma sessão a partir de uma resposta de login/cadastro. */
  startSession(session: Session) {
    this.etags.clear();
    this.adopt(session, 'local');
    this.channel?.postMessage({ type: 'session', session });
  }

  /**
   * Refresh único: chamadas simultâneas na aba esperam a mesma promessa. `failed` é o token que
   * levou o 401; se outro fluxo já trocou o token, devolve o atual sem renovar.
   */
  refresh(failed: string | null = this.token): Promise<string | null> {
    if (this.token !== null && this.token !== failed) return Promise.resolve(this.token);
    this.refreshing ??= this.runRefresh(failed).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(failed: string | null): Promise<string | null> {
    const work = async (): Promise<string | null> => {
      // Dentro do lock: outra aba pode ter renovado enquanto esperávamos (e avisado pelo canal).
      if (this.token !== null && this.token !== failed) return this.token;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.options.baseUrl}/v1/auth/refresh`, {
          method: 'POST',
          headers: CSRF,
          credentials: 'same-origin',
          cache: 'no-store',
        });
      } catch {
        throw new ApiError(0, null);
      }
      if (!res.ok) {
        // O lock é de todas as abas: se outra renovou nesse meio-tempo, o token dela já chegou.
        if (this.token !== null && this.token !== failed) return this.token;
        this.clear(this.hadSession ? 'expired' : 'anonymous', false);
        return null;
      }
      const session = (await res.json()) as Session;
      this.adopt(session, 'local');
      this.channel?.postMessage({ type: 'session', session });
      return session.access_token;
    };
    return this.locks ? this.locks.request(LOCK, work) : work();
  }

  async logout(): Promise<void> {
    // Sob o mesmo lock do refresh: o logout não pode cruzar com uma rotação em outra aba.
    const call = () =>
      this.fetchImpl(`${this.options.baseUrl}/v1/auth/logout`, {
        method: 'POST',
        headers: CSRF,
        credentials: 'same-origin',
        cache: 'no-store',
      }).then(
        () => undefined,
        () => undefined,
      );
    try {
      await (this.locks ? this.locks.request(LOCK, call) : call());
    } finally {
      this.hadSession = false;
      this.clear('logout', true);
    }
  }

  async request<T>(
    method: Method,
    path: string,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const auth = opts.auth !== false;
    const url = buildUrl(this.options.baseUrl, path, opts.query);
    if (auth && this.token === null && this.refreshing) await this.refreshing.catch(() => null);

    const attempt = async (token: string | null): Promise<Response> => {
      const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      if (auth && token) headers.authorization = `Bearer ${token}`;
      const cached = method === 'GET' ? this.etags.get(url) : undefined;
      if (cached && !('if-none-match' in headers)) headers['if-none-match'] = cached.etag;
      try {
        return await this.fetchImpl(url, {
          method,
          headers,
          credentials: 'same-origin',
          // O cache é nosso (ETag); o do navegador não pode responder no lugar do servidor.
          cache: 'no-store',
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        throw new ApiError(0, null);
      }
    };

    let used = this.token;
    let res = await attempt(used);
    if (res.status === 401 && auth) {
      const fresh = await this.refresh(used);
      if (fresh === null) {
        // O 401 que importa é o do refresh: a sessão acabou (o da rota só dizia "token vencido").
        throw new ApiError(401, { status: 401, code: 'invalid_refresh' });
      }
      used = fresh;
      res = await attempt(used);
    }

    const etag = res.headers.get('etag');
    if (res.status === 304) {
      const cached = this.etags.get(url);
      if (cached)
        return { data: cached.body as T, status: 304, etag: cached.etag, headers: res.headers };
      // 304 sem corpo guardado (não deveria acontecer): pede de novo sem condição.
      this.etags.delete(url);
      return this.request<T>(method, path, {
        ...opts,
        headers: { ...opts.headers, 'if-none-match': '' },
      });
    }
    if (!res.ok) {
      throw new ApiError(res.status, await readProblem(res), retryAfterOf(res));
    }
    const data = (res.status === 204 ? undefined : await res.json()) as T;
    if (method === 'GET' && etag) this.etags.set(url, { etag, body: data });
    return { data, status: res.status, etag, headers: res.headers };
  }

  async get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return (await this.request<T>('GET', path, opts)).data;
  }
  async post<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return (await this.request<T>('POST', path, { ...opts, body })).data;
  }
  async patch<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', path, { ...opts, body });
  }
  async del(path: string, opts: RequestOptions = {}): Promise<void> {
    await this.request<void>('DELETE', path, opts);
  }

  /** Esquece o corpo guardado de uma URL (depois de editar, por exemplo). */
  forget(pathPrefix: string) {
    for (const key of this.etags.keys()) {
      if (key.startsWith(`${this.options.baseUrl}${pathPrefix}`)) this.etags.delete(key);
    }
  }

  dispose() {
    this.channel?.close();
    this.listeners.clear();
  }
}
