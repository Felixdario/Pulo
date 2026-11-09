import { isReservedSlug, SHARED_VERSION } from '@encurtador/shared';
import Fastify, { type FastifyServerOptions } from 'fastify';

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  app.get('/healthz', async () => ({ status: 'ok', shared: SHARED_VERSION }));

  // Placeholder do caminho quente (fase 2, ADR 0002): por enquanto todo slug dá 404.
  app.get<{ Params: { slug: string } }>('/:slug', async (request, reply) => {
    const reserved = isReservedSlug(request.params.slug);
    return reply.code(404).send({ error: 'not_found', reserved });
  });

  return app;
}
