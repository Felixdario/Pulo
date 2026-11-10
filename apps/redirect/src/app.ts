import { createHmac } from 'node:crypto';
import type { Writable } from 'node:stream';
import { findLinkBySlug, type Database } from '@encurtador/db';
import {
  clickCount,
  decodeLink,
  encodeLink,
  isServable,
  jitteredTtl,
  linkKey,
  NEGATIVE,
  readThroughFill,
  takeTokenAndGet,
  toRedirectLink,
  type BucketConfig,
  type BucketResult,
  type CacheLookup,
  type RedirectLink,
} from '@encurtador/db/cache';
import {
  classifyAgent,
  compileCidrs,
  detectDevice,
  hasDeviceRules,
  hasGeoRules,
  isReservedSlug,
  mergeQuery,
  normalizeCountry,
  resolveDestination,
  SHARED_VERSION,
  type ResolveContext,
} from '@encurtador/shared';
import type { CountryLookup } from '@encurtador/geo';
import formbody from '@fastify/formbody';
import { verify as verifyPassword } from '@node-rs/argon2';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { ClickPublisher, clickFields, SaltProvider, type ClickInput } from './clicks';
import type { RedirectConfig } from './config';
import { createMetrics, type CacheLabel } from './metrics';
import { sendPasswordForm, sendProblem } from './pages';
import { hasValidUnlock, makeUnlockCookie } from './unlock';

/** Consulta de país por IP (mmdb do DB-IP Country Lite em produção; ver @encurtador/geo). */
export type { CountryLookup } from '@encurtador/geo';
export const noCountryLookup: CountryLookup = { lookup: () => null };

export interface RedirectDeps {
  db: Database;
  redis: Redis;
  config: RedirectConfig;
  countryLookup?: CountryLookup;
  /** Total de cliques humanos já gravados de um link (inicializa `cap:<id>`). Fase 3: tabela clicks. */
  loadClickTotal?: (linkId: number) => Promise<number>;
  /** Destino dos logs (testes). Padrão: stdout. */
  logStream?: Writable;
}

/** Mesmo formato aceito como alias, mais os slugs aleatórios (alfanuméricos). */
const SLUG_FORMAT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

declare module 'fastify' {
  interface FastifyRequest {
    redirect: { cache: CacheLabel; click: ClickInput | null } | null;
  }
}

const cacheControl = (link: RedirectLink) =>
  link.redirectType === 301 || link.redirectType === 308
    ? `public, max-age=${link.cacheTtl}`
    : 'private, max-age=0';

/** Location só com caracteres visíveis de US-ASCII (o resto vai percent-encoded). */
const safeLocation = (url: string) => url.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c));

const rawQuery = (url: string) => {
  const q = url.indexOf('?');
  return q === -1 ? '' : url.slice(q + 1);
};

export function buildApp(deps: RedirectDeps) {
  const { db, redis, config } = deps;
  const countryLookup = deps.countryLookup ?? noCountryLookup;
  const loadClickTotal = deps.loadClickTotal ?? (async () => 0);
  const isTrustedPeer = compileCidrs(config.trustProxy);

  const app = Fastify({
    trustProxy: config.devTrustXff
      ? true
      : config.trustProxy.length > 0
        ? config.trustProxy
        : false,
    logger: {
      level: config.logLevel,
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      // Nada de IP nos logs: o serializer não emite remoteAddress e o redact cobre o resto.
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url.split('?')[0] ?? '',
        }),
      },
      redact: {
        paths: [
          'ip',
          'req.ip',
          'req.remoteAddress',
          'req.headers.cookie',
          'req.headers["x-forwarded-for"]',
          'req.headers["x-real-ip"]',
          'req.headers["cf-connecting-ip"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: 4096,
    exposeHeadRoutes: true,
  });

  const metrics = createMetrics();
  const salts = new SaltProvider(redis);
  const publisher = new ClickPublisher(
    redis,
    {
      stream: config.clicksStream,
      maxLen: config.clicksMaxLen,
      bufferLimit: config.clicksBufferLimit,
    },
    metrics,
    app.log,
  );
  app.decorate('clicks', publisher);
  app.addHook('onClose', async () => publisher.close());

  app.decorateRequest('redirect', null);
  void app.register(formbody);

  // ---------------------------------------------------------------- Redis com fallback
  let lastRedisWarn = 0;
  const redisDown = (err: unknown) => {
    metrics.redisFallback.inc();
    const now = Date.now();
    if (now - lastRedisWarn > 10_000) {
      lastRedisWarn = now;
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'ALERTA: Redis indisponível; servindo do Postgres sem rate limit',
      );
    }
  };

  const visitorKey = (prefix: string, ip: string, extra = '') =>
    `${prefix}:${createHmac('sha256', config.secret).update(`${prefix}|${ip}`).digest('base64url').slice(0, 22)}${extra}`;

  const setRateHeaders = (reply: FastifyReply, bucket: BucketConfig, r: BucketResult) => {
    reply.header('ratelimit-limit', bucket.capacity);
    reply.header('ratelimit-remaining', r.remaining);
    reply.header('ratelimit-reset', Math.ceil(r.resetMs / 1000));
    if (!r.allowed) reply.header('retry-after', Math.max(1, Math.ceil(r.retryAfterMs / 1000)));
  };

  // ---------------------------------------------------------------- carga do link
  /** Single-flight por slug: N misses simultâneos do mesmo slug fazem 1 consulta ao Postgres. */
  const inflight = new Map<string, Promise<RedirectLink | null>>();

  const loadAndFill = (slug: string, overwrite: boolean, fill: boolean) => {
    const pending = inflight.get(slug);
    if (pending) return pending;
    const p = (async () => {
      const row = await findLinkBySlug(db, slug);
      if (fill) {
        // Valor de outra versão (stale) é sobrescrito; senão SET NX, para não atropelar a API.
        const write = overwrite
          ? redis
              .set(
                linkKey(slug),
                encodeLink(row),
                'EX',
                encodeLink(row) === NEGATIVE ? 30 : jitteredTtl(),
              )
              .then(() => true)
          : readThroughFill(redis, slug, row);
        await write.catch(redisDown);
      }
      return row && isServable(row) ? toRedirectLink(row) : null;
    })().finally(() => inflight.delete(slug));
    inflight.set(slug, p);
    return p;
  };

  /**
   * Passos 2 e 3: bucket + cache. Devolve `null` se já respondeu 429. Com o Redis fora, vai direto
   * ao Postgres, sem rate limit.
   */
  const lookupLink = async (
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
    rateLimit: boolean,
  ): Promise<{ link: RedirectLink | null; cache: CacheLabel } | null> => {
    let lookup: CacheLookup | null = null;
    let redisOk = true;
    if (rateLimit || config.cache) {
      try {
        if (rateLimit) {
          const single = config.cache && config.redisRoundTrips === 1;
          const r = await takeTokenAndGet(
            redis,
            visitorKey('rl', req.ip),
            config.bucket,
            single ? slug : undefined,
            config.bucketNow?.(),
          );
          setRateHeaders(reply, config.bucket, r);
          if (!r.allowed) {
            metrics.rateLimited.inc({ bucket: 'redirect' });
            sendProblem(req, reply, 'rate_limited');
            return null;
          }
          lookup = r.lookup;
        }
        if (config.cache && lookup === null) lookup = decodeLink(await redis.get(linkKey(slug)));
      } catch (err) {
        redisOk = false;
        redisDown(err);
      }
    }

    let result: { link: RedirectLink | null; cache: CacheLabel };
    if (!config.cache || !redisOk || lookup === null) {
      result = { link: await loadAndFill(slug, false, false), cache: 'bypass' };
    } else if (lookup.kind === 'hit') {
      result = { link: lookup.link, cache: 'hit' };
    } else if (lookup.kind === 'negative') {
      result = { link: null, cache: 'negative' };
    } else {
      result = { link: await loadAndFill(slug, lookup.kind === 'stale', true), cache: 'miss' };
    }
    metrics.cacheRequests.inc({ result: result.cache });
    return result;
  };

  const countryOf = (req: FastifyRequest, withLookup: boolean): string | null => {
    const peer = req.socket.remoteAddress ?? '';
    if (config.devTrustXff || isTrustedPeer(peer)) {
      const h = req.headers['cf-ipcountry'] ?? req.headers['x-country'];
      const v = normalizeCountry(Array.isArray(h) ? h[0] : h);
      if (v) return v;
    }
    return withLookup ? countryLookup.lookup(req.ip) : null;
  };

  // ---------------------------------------------------------------- rotas
  app.get('/healthz', async () => ({ status: 'ok', shared: SHARED_VERSION }));
  app.get('/metrics', async (_req, reply) =>
    reply.type(metrics.registry.contentType).send(await metrics.registry.metrics()),
  );
  app.get('/', async (req, reply) => sendProblem(req, reply, 'not_found'));

  app.get<{ Params: { slug: string } }>('/:slug', async (req, reply) => {
    const ctx: NonNullable<FastifyRequest['redirect']> = { cache: 'none', click: null };
    req.redirect = ctx;
    const { slug } = req.params;

    // 1. reservado ou formato inválido: 404 sem tocar no Redis.
    if (!SLUG_FORMAT.test(slug) || isReservedSlug(slug))
      return sendProblem(req, reply, 'not_found');

    // 2–3. bucket + cache.
    const found = await lookupLink(req, reply, slug, config.rateLimit);
    if (!found) return reply;
    ctx.cache = found.cache;
    const { link } = found;

    // 4. inexistente, desativado ou apagado: a mesma resposta.
    if (!link || link.status !== 'active') return sendProblem(req, reply, 'not_found');

    // 5. expirado.
    if (link.expiresAt !== null && link.expiresAt <= Date.now()) {
      return sendProblem(req, reply, 'expired');
    }

    // 6. senha sem cookie de desbloqueio.
    if (
      link.passwordVersion !== null &&
      !hasValidUnlock(config.secret, req.headers.cookie, {
        slug,
        id: link.id,
        passwordVersion: link.passwordVersion,
      })
    ) {
      const q = rawQuery(req.url);
      return sendPasswordForm(req, reply, `/${slug}${q ? `?${q}` : ''}`);
    }

    // 7. limite de cliques: só humanos consomem; robôs e prévias só olham.
    const ua = req.headers['user-agent'];
    const kind = classifyAgent(ua, req.method);
    if (link.maxClicks !== null) {
      try {
        const count = await clickCount(redis, link.id, kind === 'human' ? 'incr' : 'peek', () =>
          loadClickTotal(link.id),
        );
        if (kind === 'human' ? count > link.maxClicks : count >= link.maxClicks) {
          return sendProblem(req, reply, 'limit_reached');
        }
      } catch (err) {
        // Sem Redis não há contador: o link continua funcionando (ADR: não derrubar redirects).
        redisDown(err);
      }
    }

    // 8. destino: país → dispositivo → padrão.
    const geo = hasGeoRules(link.rules);
    const country = countryOf(req, geo);
    const rc: ResolveContext = { country };
    if (hasDeviceRules(link.rules)) Object.assign(rc, detectDevice(ua));
    let destination = resolveDestination(link, rc);
    // Defesa em profundidade: a API valida com validateDestination, mas o banco não impede um
    // destino (ou URL de regra) fora de http/https gravado por outro caminho.
    if (!/^https?:\/\//i.test(destination)) {
      req.log.warn({ linkId: link.id }, 'destino com esquema não permitido; respondendo 404');
      return sendProblem(req, reply, 'not_found');
    }

    // 9. query string e UTMs (as do destino vencem).
    if (link.forwardQuery) destination = mergeQuery(destination, rawQuery(req.url));

    // 10. responde; o XADD sai no onResponse, depois que a resposta foi enviada.
    ctx.click = {
      linkId: link.id,
      ip: req.ip,
      ua,
      ref: req.headers.referer,
      country,
      kind,
    };
    return reply
      .code(link.redirectType)
      .header('location', safeLocation(destination))
      .header('cache-control', cacheControl(link))
      .header('referrer-policy', 'unsafe-url')
      .send();
  });

  app.post<{ Params: { slug: string }; Body: { password?: unknown } | undefined }>(
    '/:slug',
    async (req, reply) => {
      const ctx: NonNullable<FastifyRequest['redirect']> = { cache: 'none', click: null };
      req.redirect = ctx;
      const { slug } = req.params;
      if (!SLUG_FORMAT.test(slug) || isReservedSlug(slug))
        return sendProblem(req, reply, 'not_found');

      // Bucket próprio e apertado (5/min por visitante e link), mesmo com RATE_LIMIT=off.
      try {
        const r = await takeTokenAndGet(
          redis,
          visitorKey('rlp', req.ip, `:${slug}`),
          config.passwordBucket,
          undefined,
          config.bucketNow?.(),
        );
        setRateHeaders(reply, config.passwordBucket, r);
        if (!r.allowed) {
          metrics.rateLimited.inc({ bucket: 'password' });
          return sendProblem(req, reply, 'rate_limited');
        }
      } catch (err) {
        redisDown(err);
      }

      const found = await lookupLink(req, reply, slug, false);
      if (!found) return reply;
      ctx.cache = found.cache;
      const { link } = found;
      if (!link || link.status !== 'active') return sendProblem(req, reply, 'not_found');
      if (link.expiresAt !== null && link.expiresAt <= Date.now()) {
        return sendProblem(req, reply, 'expired');
      }
      const q = rawQuery(req.url);
      const target = `/${slug}${q ? `?${q}` : ''}`;
      if (link.passwordVersion === null) return reply.code(303).header('location', target).send();

      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const row = await findLinkBySlug(db, slug);
      const ok =
        password !== '' &&
        password.length <= 1024 &&
        row?.passwordHash != null &&
        (await verifyPassword(row.passwordHash, password).catch(() => false));
      if (!ok) return sendPasswordForm(req, reply, target, 401);

      const cookie = makeUnlockCookie(
        config.secret,
        { slug, id: link.id, passwordVersion: link.passwordVersion },
        config.secureCookies,
      );
      return reply
        .code(303)
        .header('set-cookie', cookie)
        .header('cache-control', 'no-store')
        .header('location', target)
        .send();
    },
  );

  app.setErrorHandler((err: Error & { code?: string }, req, reply) => {
    req.log.error({ err: { message: err.message, code: err.code } }, 'erro');
    const status = (err as { statusCode?: number }).statusCode ?? 503;
    return reply
      .code(status >= 400 && status < 500 ? status : 503)
      .header('cache-control', 'no-store')
      .type('application/problem+json')
      .send(
        JSON.stringify({
          type: 'about:blank',
          title: 'Indisponível',
          status: status < 500 ? status : 503,
        }),
      );
  });

  // ---------------------------------------------------------------- depois da resposta
  app.addHook('onResponse', async (req, reply) => {
    const ctx = req.redirect;
    if (!ctx) return;
    metrics.duration.observe(
      { status: String(reply.statusCode), cache: ctx.cache },
      reply.elapsedTime / 1000,
    );
    const click = ctx.click;
    if (!click) return;
    ctx.click = null; // solta o IP desta requisição
    const salt = await salts.get();
    publisher.publish(clickFields(click, salt));
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    clicks: ClickPublisher;
  }
}
