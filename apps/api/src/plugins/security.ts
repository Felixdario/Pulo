import { API_SCOPES, findApiKeyByPrefix, touchApiKey, type ApiScope } from '@encurtador/db';
import { takeTokenAndGet, type BucketConfig, type BucketResult } from '@encurtador/db/cache';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_KEY_REGEX, hmacKey, safeEqual, sha256 } from '../lib/crypto';
import { ApiError } from '../lib/problem';
import type { AccessTokens } from '../modules/auth/tokens';
import type { AuthContext, Ctx } from '../types';

const ALL_SCOPES: ReadonlySet<ApiScope> = new Set(API_SCOPES);
/** Hash de comparação quando o prefixo não existe: o tempo de resposta não revela prefixos válidos. */
const DUMMY_HASH = sha256('enc_00000000_00000000000000000000000000000000');
const LAST_USED_DEBOUNCE_SECONDS = 60;

export function setRateHeaders(reply: FastifyReply, bucket: BucketConfig, r: BucketResult) {
  reply.header('ratelimit-limit', bucket.capacity);
  reply.header('ratelimit-remaining', r.remaining);
  reply.header('ratelimit-reset', Math.ceil(r.resetMs / 1000));
  if (!r.allowed) reply.header('retry-after', Math.max(1, Math.ceil(r.retryAfterMs / 1000)));
}

/**
 * Consome uma ficha do balde e põe os cabeçalhos `RateLimit-*`. Com o Redis fora, deixa passar
 * (mesma escolha do redirect: não derrubar a API por causa do rate limit) e registra.
 */
export async function consume(
  ctx: Ctx,
  req: FastifyRequest,
  reply: FastifyReply,
  key: string,
  bucket: BucketConfig,
): Promise<void> {
  if (!ctx.config.rateLimit) return;
  let r: BucketResult;
  try {
    r = await takeTokenAndGet(ctx.redis, key, bucket);
  } catch (err) {
    req.log.warn({ err: (err as Error).message }, 'rate limit indisponível (Redis)');
    return;
  }
  setRateHeaders(reply, bucket, r);
  if (!r.allowed)
    throw new ApiError('rate_limited', 'Tente de novo depois de Retry-After segundos.');
}

export const visitorKey = (ctx: Ctx, purpose: string, value: string) =>
  `rla:${purpose}:${hmacKey(ctx.config.hmacSecret, purpose, value)}`;

/**
 * Autenticação e rate limit em `onRequest`, antes do parse do corpo (ADR 0004):
 * 1. identifica `Authorization: Bearer <jwt>`, `Authorization: Bearer enc_…` ou `X-API-Key`;
 * 2. consome do balde do usuário, da chave ou, sem credencial válida, do IP (HMAC);
 * 3. aplica a exigência da rota: 401 sem credencial, 403 sem o escopo.
 */
export function registerSecurity(app: FastifyInstance, ctx: Ctx, tokens: AccessTokens) {
  app.decorateRequest('auth', null);
  app.decorateRequest('authFailure', null);

  async function fromApiKey(req: FastifyRequest, key: string): Promise<AuthContext | null> {
    const m = API_KEY_REGEX.exec(key);
    if (!m) {
      req.authFailure = 'chave de API malformada';
      return null;
    }
    const row = await findApiKeyByPrefix(ctx.db, m[1]!);
    const hash = sha256(key);
    const matches = safeEqual(hash, row?.keyHash ?? DUMMY_HASH);
    if (!row || !matches || row.revokedAt !== null) {
      req.authFailure = 'chave de API inválida ou revogada';
      return null;
    }
    // last_used_at: no máximo uma escrita por minuto por chave.
    void ctx.redis
      .set(`ak:used:${row.id}`, '1', 'EX', LAST_USED_DEBOUNCE_SECONDS, 'NX')
      .then((ok) => (ok === 'OK' ? touchApiKey(ctx.db, row.id) : undefined))
      .catch((err: Error) => req.log.warn({ err: err.message }, 'falha ao gravar last_used_at'));
    return { userId: row.userId, kind: 'key', keyId: row.id, scopes: new Set(row.scopes) };
  }

  async function identify(req: FastifyRequest): Promise<AuthContext | null> {
    const xKey = req.headers['x-api-key'];
    if (typeof xKey === 'string' && xKey !== '') return fromApiKey(req, xKey.trim());
    const header = req.headers.authorization;
    if (!header) return null;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!m) {
      req.authFailure = 'use Authorization: Bearer <token>';
      return null;
    }
    const token = m[1]!;
    if (token.startsWith('enc_')) return fromApiKey(req, token);
    const userId = await tokens.verify(token);
    if (userId === null) {
      req.authFailure = 'access token inválido ou expirado';
      return null;
    }
    return { userId, kind: 'session', keyId: null, scopes: ALL_SCOPES };
  }

  app.addHook('onRequest', async (req, reply) => {
    req.auth = await identify(req);
    const a = req.auth;
    const subject = a
      ? a.kind === 'key'
        ? `rla:k:${a.keyId}`
        : `rla:u:${a.userId}`
      : visitorKey(ctx, 'ip', req.ip);
    await consume(ctx, req, reply, subject, ctx.config.bucket);

    const cfg = req.routeOptions.config;
    const route = req.routeOptions.url ?? '';
    const required = route.startsWith('/v1') && cfg.auth !== 'none';
    if (!required) return;
    if (!a) {
      reply.header('www-authenticate', 'Bearer realm="encurtador"');
      throw new ApiError(
        'unauthorized',
        req.authFailure ?? 'envie um access token ou chave de API',
      );
    }
    if (cfg.sessionOnly && a.kind !== 'session') {
      throw new ApiError('session_required', 'chaves de API não gerenciam chaves de API');
    }
    if (cfg.scope && !a.scopes.has(cfg.scope)) {
      throw new ApiError('insufficient_scope', `esta rota exige o escopo ${cfg.scope}`, {
        required_scope: cfg.scope,
      });
    }
  });
}

/** `req.auth` depois do hook; só para rotas com autenticação exigida. */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new ApiError('unauthorized');
  return req.auth;
}
