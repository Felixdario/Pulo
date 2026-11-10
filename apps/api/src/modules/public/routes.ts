import { createLink, SlugExhaustedError } from '@encurtador/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, errorResponses, type FieldError } from '../../lib/problem';
import { consume, visitorKey } from '../../plugins/security';
import type { Ctx } from '../../types';
import { checkDestination, syncCache } from '../links/service';

export function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/v1/public/links',
    {
      config: { auth: 'none' },
      schema: {
        tags: ['public'],
        summary: 'Encurta sem login',
        description:
          'Link anônimo com slug aleatório que expira em 30 dias; sem alias, regras ou senha. 10 por minuto por visitante (HMAC do IP).',
        body: z
          .object({ destination: z.string().min(1).max(4096) })
          .strict()
          .meta({ example: { destination: 'https://exemplo.com/artigo' } }),
        response: {
          201: z
            .object({
              slug: z.string(),
              short_url: z.string(),
              destination: z.string(),
              expires_at: z.string(),
            })
            .meta({
              example: {
                slug: 'aB3xK9q',
                short_url: 'https://encurta.dev/aB3xK9q',
                destination: 'https://exemplo.com/artigo',
                expires_at: '2026-12-09T12:00:00.000Z',
              },
            }),
          ...errorResponses(400, 422, 429),
        },
      },
    },
    async (req, reply) => {
      await consume(ctx, req, reply, visitorKey(ctx, 'public', req.ip), ctx.config.publicBucket);
      const errors: FieldError[] = [];
      const destination = checkDestination(ctx, req.body.destination, 'destination', errors);
      if (!destination) throw new ApiError('validation', 'destino inválido', { errors });
      const expiresAt = new Date(Date.now() + ctx.config.publicLinkTtlDays * 86_400_000);
      let link;
      try {
        link = await createLink(ctx.db, { userId: null, destination, expiresAt });
      } catch (err) {
        if (err instanceof SlugExhaustedError) throw new ApiError('slug_exhausted');
        throw err;
      }
      await syncCache(ctx, req.log, link.slug, link);
      const shortUrl = `${ctx.config.shortBaseUrl}/${link.slug}`;
      return reply.code(201).header('location', shortUrl).send({
        slug: link.slug,
        short_url: shortUrl,
        destination: link.destination,
        expires_at: expiresAt.toISOString(),
      });
    },
  );
}
