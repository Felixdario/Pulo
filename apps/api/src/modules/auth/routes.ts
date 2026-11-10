import { randomUUID } from 'node:crypto';
import {
  createUser,
  findUserByEmail,
  findUserById,
  insertRefreshToken,
  normalizeEmail,
  revokeRefreshFamily,
  rotateRefreshToken,
  type User,
} from '@encurtador/db';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomToken, sha256 } from '../../lib/crypto';
import { ApiError, errorResponses } from '../../lib/problem';
import { SECURITY } from '../../openapi';
import { authOf, consume, visitorKey } from '../../plugins/security';
import type { Ctx } from '../../types';
import type { AccessTokens } from './tokens';

const credentials = z
  .object({
    email: z.email().max(254),
    password: z.string().min(8).max(256),
  })
  .strict()
  .meta({ example: { email: 'demo@encurta.dev', password: 'demo1234' } });

const userSchema = z
  .object({ id: z.number().int(), email: z.string(), created_at: z.string() })
  .meta({ id: 'User' });

const sessionSchema = z
  .object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int(),
    user: userSchema,
  })
  .meta({
    id: 'Session',
    example: {
      access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…',
      token_type: 'Bearer',
      expires_in: 900,
      user: { id: 1, email: 'demo@encurta.dev', created_at: '2026-11-09T12:00:00.000Z' },
    },
  });

const csrfHeader = z
  .object({
    'x-requested-with': z
      .string()
      .optional()
      .meta({ description: 'Precisa ser `encurtador` (proteção contra CSRF).' }),
  })
  .loose();

const serializeUser = (u: User) => ({
  id: u.id,
  email: u.email,
  created_at: u.createdAt.toISOString(),
});

function readCookie(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function authRoutes(app: FastifyInstance, ctx: Ctx, tokens: AccessTokens) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { config } = ctx;
  const cookieName = config.secureCookies ? '__Host-refresh' : 'refresh';
  const tags = ['auth'];

  const cookie = (value: string, maxAge: number) =>
    [
      `${cookieName}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
      ...(config.secureCookies ? ['Secure'] : []),
    ].join('; ');

  /** Argon2 de uma senha qualquer, para o login de e-mail inexistente gastar o mesmo tempo. */
  let dummyHash: Promise<string> | null = null;
  const dummy = () => (dummyHash ??= argon2Hash(randomToken(16)));

  async function issueSession(reply: FastifyReply, user: User) {
    const refresh = randomToken(32);
    await insertRefreshToken(ctx.db, {
      userId: user.id,
      familyId: randomUUID(),
      tokenHash: sha256(refresh),
      expiresAt: new Date(Date.now() + config.refreshTtlSeconds * 1000),
    });
    reply.header('set-cookie', cookie(refresh, config.refreshTtlSeconds));
    reply.header('cache-control', 'no-store');
    return {
      access_token: await tokens.sign(user.id),
      token_type: 'Bearer' as const,
      expires_in: config.accessTtlSeconds,
      user: serializeUser(user),
    };
  }

  /** 10/min por IP (HMAC) e por e-mail, além do balde geral. */
  async function authBuckets(req: FastifyRequest, reply: FastifyReply, email: string) {
    await consume(ctx, req, reply, visitorKey(ctx, 'auth-ip', req.ip), config.authBucket);
    await consume(
      ctx,
      req,
      reply,
      visitorKey(ctx, 'auth-email', normalizeEmail(email)),
      config.authBucket,
    );
  }

  function requireCsrfHeader(req: FastifyRequest) {
    if (req.headers['x-requested-with'] !== 'encurtador') {
      throw new ApiError('csrf', 'envie X-Requested-With: encurtador');
    }
  }

  r.post(
    '/v1/auth/signup',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Cria uma conta e já abre a sessão',
        body: credentials,
        response: { 201: sessionSchema, ...errorResponses(400, 409, 422, 429) },
      },
    },
    async (req, reply) => {
      await authBuckets(req, reply, req.body.email);
      const user = await createUser(ctx.db, req.body.email, await argon2Hash(req.body.password));
      if (!user) throw new ApiError('email_taken', 'já existe uma conta com este e-mail');
      const session = await issueSession(reply, user);
      return reply.code(201).header('location', '/v1/me').send(session);
    },
  );

  r.post(
    '/v1/auth/login',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Login com e-mail e senha',
        description:
          'Mesma resposta e tempo parecido para e-mail inexistente e senha errada. Grava o refresh no cookie httpOnly (`__Host-refresh` em produção, `refresh` em dev).',
        body: credentials,
        response: { 200: sessionSchema, ...errorResponses(400, 401, 422, 429) },
      },
    },
    async (req, reply) => {
      await authBuckets(req, reply, req.body.email);
      const user = await findUserByEmail(ctx.db, req.body.email);
      const hash = user?.passwordHash ?? (await dummy());
      const ok = await argon2Verify(hash, req.body.password).catch(() => false);
      if (!user || !ok) throw new ApiError('invalid_credentials');
      return issueSession(reply, user);
    },
  );

  r.post(
    '/v1/auth/refresh',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Troca o refresh do cookie por um access token novo',
        description:
          'Rotação: o refresh usado é revogado e um novo vai no cookie. Um refresh já usado apresentado de novo revoga a família inteira (todas as sessões daquele login).',
        headers: csrfHeader,
        response: { 200: sessionSchema, ...errorResponses(401, 403, 429) },
      },
    },
    async (req, reply) => {
      requireCsrfHeader(req);
      const current = readCookie(req, cookieName);
      const clear = () => reply.header('set-cookie', cookie('', 0));
      if (!current) {
        clear();
        throw new ApiError('invalid_refresh', 'sem cookie de refresh');
      }
      const next = randomToken(32);
      const rotated = await rotateRefreshToken(ctx.db, sha256(current), {
        tokenHash: sha256(next),
        expiresAt: new Date(Date.now() + config.refreshTtlSeconds * 1000),
      });
      if (rotated.kind !== 'rotated') {
        clear();
        if (rotated.kind === 'reused') {
          req.log.warn({ userId: rotated.userId }, 'refresh reutilizado: família revogada');
        }
        throw new ApiError('invalid_refresh');
      }
      const user = await findUserById(ctx.db, rotated.userId);
      if (!user) throw new ApiError('invalid_refresh');
      reply.header('set-cookie', cookie(next, config.refreshTtlSeconds));
      reply.header('cache-control', 'no-store');
      return {
        access_token: await tokens.sign(user.id),
        token_type: 'Bearer' as const,
        expires_in: config.accessTtlSeconds,
        user: serializeUser(user),
      };
    },
  );

  r.post(
    '/v1/auth/logout',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Encerra a sessão (revoga a família do refresh)',
        headers: csrfHeader,
        response: { 204: z.undefined(), ...errorResponses(403, 429) },
      },
    },
    async (req, reply) => {
      requireCsrfHeader(req);
      const current = readCookie(req, cookieName);
      if (current) await revokeRefreshFamily(ctx.db, sha256(current));
      return reply.code(204).header('set-cookie', cookie('', 0)).send();
    },
  );

  r.get(
    '/v1/me',
    {
      schema: {
        tags,
        summary: 'Usuário autenticado',
        security: SECURITY,
        response: {
          200: userSchema.extend({
            auth: z.object({
              kind: z.enum(['session', 'key']),
              scopes: z.array(z.string()),
            }),
          }),
          ...errorResponses(401, 429),
        },
      },
    },
    async (req) => {
      const a = authOf(req);
      const user = await findUserById(ctx.db, a.userId);
      if (!user) throw new ApiError('unauthorized', 'usuário não existe mais');
      return { ...serializeUser(user), auth: { kind: a.kind, scopes: [...a.scopes].sort() } };
    },
  );
}
