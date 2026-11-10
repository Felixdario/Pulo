import type { Writable } from 'node:stream';
import type { Database } from '@encurtador/db';
import { SHARED_VERSION } from '@encurtador/shared';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { ApiConfig } from './config';
import { authRoutes } from './modules/auth/routes';
import { AccessTokens } from './modules/auth/tokens';
import { keyRoutes } from './modules/keys/routes';
import { linkRoutes } from './modules/links/routes';
import { LiveHub } from './modules/live/hub';
import { liveRoutes } from './modules/live/routes';
import { overviewRoutes } from './modules/overview/routes';
import type { Resolver } from './modules/preview/fetcher';
import { previewRoutes } from './modules/preview/routes';
import { publicRoutes } from './modules/public/routes';
import { statsRoutes } from './modules/stats/routes';
import { OPENAPI_DOCUMENT } from './openapi';
import { registerErrors, registerEtag, registerIdempotency } from './plugins/http';
import { registerSecurity } from './plugins/security';
import type { Ctx } from './types';

export interface ApiDeps {
  db: Database;
  redis: Redis;
  config: ApiConfig;
  /** Conexão dedicada ao SUBSCRIBE do SSE. Padrão: `redis.duplicate()`. */
  subscriber?: Redis;
  /** Resolvedor DNS do buscador da prévia (testes). */
  resolve?: Resolver;
  /** Política de IP do buscador da prévia (testes). Padrão: só IP público. */
  isAllowedAddress?: (ip: string) => boolean;
  logStream?: Writable;
}

export const EXPOSED_HEADERS = [
  'etag',
  'location',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'idempotent-replayed',
];

export async function buildApp(deps: ApiDeps) {
  const { config } = deps;
  const ctx: Ctx = { db: deps.db, redis: deps.redis, config };

  const app = Fastify({
    trustProxy: config.devTrustXff
      ? true
      : config.trustProxy.length > 0
        ? config.trustProxy
        : false,
    bodyLimit: 64 * 1024,
    logger: {
      level: config.logLevel,
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      // Sem IP, cookies nem credenciais nos logs.
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url.split('?')[0] ?? '',
        }),
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Só JSON: corpo em texto puro vira 415 em vez de um 422 confuso.
  app.removeContentTypeParser('text/plain');

  // CORS primeiro: os cabeçalhos ficam até nas respostas de erro dos hooks seguintes.
  await app.register(cors, {
    origin: config.webOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'if-match',
      'if-none-match',
      'x-api-key',
      'x-requested-with',
    ],
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: 600,
  });

  await app.register(swagger, {
    openapi: OPENAPI_DOCUMENT,
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  const tokens = new AccessTokens(config);
  registerErrors(app);
  registerSecurity(app, ctx, tokens);
  registerIdempotency(app, ctx);
  registerEtag(app);

  const hub = new LiveHub(deps.subscriber ?? deps.redis.duplicate());
  app.addHook('onClose', async () => hub.close());

  app.get(
    '/healthz',
    {
      schema: {
        tags: ['infra'],
        response: { 200: z.object({ status: z.literal('ok'), shared: z.string() }) },
      },
    },
    async () => ({ status: 'ok' as const, shared: SHARED_VERSION }),
  );

  authRoutes(app, ctx, tokens);
  keyRoutes(app, ctx);
  linkRoutes(app, ctx);
  statsRoutes(app, ctx);
  overviewRoutes(app, ctx);
  liveRoutes(app, ctx, hub);
  previewRoutes(app, ctx, {
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.isAllowedAddress ? { isAllowedAddress: deps.isAllowedAddress } : {}),
  });
  publicRoutes(app, ctx);

  return app;
}

export type ApiApp = Awaited<ReturnType<typeof buildApp>>;
