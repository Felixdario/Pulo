import { API_SCOPES, insertApiKey, listApiKeys, revokeApiKey, type ApiKey } from '@encurtador/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { generateApiKey } from '../../lib/crypto';
import { ApiError, errorResponses } from '../../lib/problem';
import { SECURITY } from '../../openapi';
import { authOf } from '../../plugins/security';
import type { Ctx } from '../../types';
import { idParams } from '../links/schemas';

const scopes = z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length);

const keySchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    /** Só o prefixo: o segredo nunca volta depois da criação. */
    display: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
  })
  .meta({
    id: 'ApiKey',
    example: {
      id: 7,
      name: 'CI',
      display: 'enc_AbCd1234_…',
      prefix: 'AbCd1234',
      scopes: ['links:read', 'links:write'],
      last_used_at: null,
      created_at: '2026-11-09T12:00:00.000Z',
    },
  });

const serializeKey = (k: ApiKey) => ({
  id: k.id,
  name: k.name,
  display: `enc_${k.prefix}_…`,
  prefix: k.prefix,
  scopes: [...k.scopes],
  last_used_at: k.lastUsedAt?.toISOString() ?? null,
  created_at: k.createdAt.toISOString(),
});

export function keyRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['api-keys'];
  const config = { sessionOnly: true } as const;

  r.post(
    '/v1/api-keys',
    {
      config,
      schema: {
        tags,
        summary: 'Cria uma chave de API (o segredo aparece só nesta resposta)',
        description:
          'Sem `Idempotency-Key`: a resposta leva o segredo, que não pode ficar gravado para repetição. Uma chave criada a mais é só revogar.',
        security: SECURITY,
        body: z
          .object({ name: z.string().trim().min(1).max(100), scopes })
          .strict()
          .meta({ example: { name: 'CI', scopes: ['links:read', 'links:write'] } }),
        response: {
          201: keySchema.extend({ key: z.string() }),
          ...errorResponses(400, 401, 403, 422, 429),
        },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      for (let attempt = 0; attempt < 3; attempt++) {
        const g = generateApiKey();
        const row = await insertApiKey(ctx.db, {
          userId,
          name: req.body.name,
          prefix: g.prefix,
          keyHash: g.hash,
          scopes: [...new Set(req.body.scopes)],
        });
        if (row) {
          return reply
            .code(201)
            .header('location', `/v1/api-keys/${row.id}`)
            .header('cache-control', 'no-store')
            .send({ ...serializeKey(row), key: g.key });
        }
      }
      throw new ApiError('internal', 'colisão de prefixo repetida');
    },
  );

  r.get(
    '/v1/api-keys',
    {
      config,
      schema: {
        tags,
        summary: 'Lista as chaves ativas',
        security: SECURITY,
        response: { 200: z.object({ data: z.array(keySchema) }), ...errorResponses(401, 403, 429) },
      },
    },
    async (req) => ({ data: (await listApiKeys(ctx.db, authOf(req).userId)).map(serializeKey) }),
  );

  r.delete(
    '/v1/api-keys/:id',
    {
      config,
      schema: {
        tags,
        summary: 'Revoga uma chave (para de funcionar na hora)',
        security: SECURITY,
        params: idParams,
        response: { 204: z.undefined(), ...errorResponses(401, 403, 404, 429) },
      },
    },
    async (req, reply) => {
      if (!(await revokeApiKey(ctx.db, authOf(req).userId, req.params.id))) {
        throw new ApiError('not_found', 'chave não encontrada');
      }
      return reply.code(204).send();
    },
  );
}
