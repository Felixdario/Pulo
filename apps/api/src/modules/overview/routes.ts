import { accountOverview } from '@encurtador/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/problem';
import { SECURITY } from '../../openapi';
import { authOf } from '../../plugins/security';
import type { Ctx } from '../../types';
import { dayRangeQuery, resolveDayRange } from '../stats/range';

const counts = {
  total: z.number().int(),
  humans: z.number().int(),
  bots: z.number().int(),
  previews: z.number().int(),
};

export function overviewRoutes(app: FastifyInstance, ctx: Ctx) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/v1/overview',
    {
      config: { scope: 'stats:read' },
      schema: {
        tags: ['overview'],
        summary: 'Visão geral da conta',
        description:
          'Total de links ativos (não apagados), cliques no período (dias UTC, inclusive; padrão 30 dias), top links por cliques humanos e série diária da conta. Só agregados.',
        security: SECURITY,
        querystring: dayRangeQuery.extend({
          limit: z.coerce.number().int().min(1).max(50).default(5),
        }),
        response: {
          200: z.object({
            links_total: z.number().int(),
            from: z.string(),
            to: z.string(),
            clicks: z.object(counts),
            top_links: z.array(
              z
                .object({
                  id: z.number().int(),
                  slug: z.string(),
                  short_url: z.string(),
                  title: z.string().nullable(),
                  ...counts,
                })
                .omit({ bots: true, previews: true }),
            ),
            series: z.array(z.object({ day: z.string(), ...counts })),
          }),
          ...errorResponses(401, 403, 422, 429),
        },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const range = resolveDayRange(req.query);
      const o = await accountOverview(ctx.db, {
        userId,
        fromDay: range.fromDay,
        toDay: range.toDay,
        limit: req.query.limit,
      });
      const sum = (k: 'total' | 'humans' | 'bots' | 'previews') =>
        o.series.reduce((acc, d) => acc + d[k], 0);
      return {
        links_total: o.linksTotal,
        from: range.from,
        to: range.to,
        clicks: {
          total: sum('total'),
          humans: sum('humans'),
          bots: sum('bots'),
          previews: sum('previews'),
        },
        top_links: o.topLinks.map((l) => ({
          ...l,
          short_url: `${ctx.config.shortBaseUrl}/${l.slug}`,
        })),
        series: o.series,
      };
    },
  );
}
