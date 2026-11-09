import { SHARED_VERSION } from '@encurtador/shared';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

export async function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: { title: 'Encurtador API', version: SHARED_VERSION },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

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

  return app;
}
