import { linkSummary, timeseries, topDimension, type ClickDimension } from '@encurtador/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/problem';
import { SECURITY } from '../../openapi';
import { authOf } from '../../plugins/security';
import type { Ctx } from '../../types';
import { loadOwned } from '../links/routes';
import { idParams } from '../links/schemas';
import {
  dayRangeQuery,
  resolveDayRange,
  resolveSeriesRange,
  timeseriesQuery,
  topQuery,
} from './range';

const UNIQUES_NOTE =
  'Únicos só existem por dia UTC (visitante = HMAC com sal diário, ADR 0003): vêm com granularity=day e tz=UTC; nos outros casos, null.';

const pointSchema = z.object({
  start: z.string(),
  label: z.string(),
  total: z.number().int(),
  humans: z.number().int(),
  uniques: z.number().int().nullable(),
  bots: z.number().int(),
  previews: z.number().int(),
});

const DIMENSIONS: Record<string, ClickDimension> = {
  countries: 'country',
  cities: 'city',
  referrers: 'referrer',
  browsers: 'browser',
  os: 'os',
  devices: 'device',
};

const topSchema = z.object({
  link_id: z.number().int(),
  dimension: z.string(),
  from: z.string(),
  to: z.string(),
  total: z.number().int(),
  items: z.array(z.object({ value: z.string(), n: z.number().int(), share: z.number() })),
  others: z.number().int(),
});

export function statsRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['stats'];
  const config = { scope: 'stats:read' } as const;
  const errors = errorResponses(401, 403, 404, 410, 422, 429);

  r.get(
    '/v1/links/:id/stats/timeseries',
    {
      config,
      schema: {
        tags,
        summary: 'Série temporal de cliques',
        description:
          'Só agregados. `hour` (até 14 dias) e `day`/`month` fora de UTC somam as horas do `clicks_hourly` no fuso pedido; ' +
          '`day`/`month` em UTC leem o `clicks_daily`. ' +
          UNIQUES_NOTE,
        security: SECURITY,
        params: idParams,
        querystring: timeseriesQuery,
        response: {
          200: z.object({
            link_id: z.number().int(),
            granularity: z.enum(['hour', 'day', 'month']),
            tz: z.string(),
            from: z.string(),
            to: z.string(),
            source: z.enum(['hourly', 'daily']),
            uniques_available: z.boolean(),
            uniques_note: z.string(),
            totals: pointSchema.omit({ start: true, label: true }),
            points: z.array(pointSchema),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const link = await loadOwned(ctx, authOf(req).userId, req.params.id);
      const q = req.query;
      const { from, to } = resolveSeriesRange(q);
      const s = await timeseries(ctx.db, {
        linkId: link.id,
        granularity: q.granularity,
        from,
        to,
        tz: q.tz,
      });
      const withUniques = s.points.length > 0 && s.points[0]!.uniques !== null;
      const sum = (k: 'total' | 'humans' | 'bots' | 'previews') =>
        s.points.reduce((acc, p) => acc + p[k], 0);
      return {
        link_id: link.id,
        granularity: q.granularity,
        tz: q.tz,
        from: from.toISOString(),
        to: to.toISOString(),
        source: s.source,
        uniques_available: withUniques,
        uniques_note: UNIQUES_NOTE,
        totals: {
          total: sum('total'),
          humans: sum('humans'),
          uniques: withUniques ? s.points.reduce((acc, p) => acc + (p.uniques ?? 0), 0) : null,
          bots: sum('bots'),
          previews: sum('previews'),
        },
        points: s.points,
      };
    },
  );

  for (const [path, dim] of Object.entries(DIMENSIONS)) {
    r.get(
      `/v1/links/:id/stats/${path}`,
      {
        config,
        schema: {
          tags,
          summary: `Top ${path} (cliques humanos)`,
          description:
            'Top N valores no período (dias UTC, inclusive) e o resto somado em `others`. Valor ausente vira "(desconhecido)"' +
            (dim === 'city' ? '; cidade vem como `<país>/<cidade>`.' : '.'),
          security: SECURITY,
          params: idParams,
          querystring: topQuery,
          response: { 200: topSchema, ...errors },
        },
      },
      async (req) => {
        const link = await loadOwned(ctx, authOf(req).userId, req.params.id);
        const range = resolveDayRange(req.query);
        const top = await topDimension(ctx.db, {
          linkId: link.id,
          dim,
          fromDay: range.fromDay,
          toDay: range.toDay,
          limit: req.query.limit,
        });
        return {
          link_id: link.id,
          dimension: dim,
          from: range.from,
          to: range.to,
          total: top.total,
          items: top.items.map((i) => ({
            ...i,
            share: top.total > 0 ? Math.round((i.n / top.total) * 10_000) / 10_000 : 0,
          })),
          others: top.others,
        };
      },
    );
  }

  r.get(
    '/v1/links/:id/stats/summary',
    {
      config,
      schema: {
        tags,
        summary: 'Totais do período',
        description:
          '`uniques` soma os únicos de cada dia UTC (quem volta em outro dia conta de novo). `unique_ratio` = uniques / humans.',
        security: SECURITY,
        params: idParams,
        querystring: dayRangeQuery,
        response: {
          200: z.object({
            link_id: z.number().int(),
            from: z.string(),
            to: z.string(),
            total: z.number().int(),
            humans: z.number().int(),
            uniques: z.number().int(),
            unique_ratio: z.number().nullable(),
            bots: z.number().int(),
            previews: z.number().int(),
            preview_apps: z.array(z.object({ app: z.string(), n: z.number().int() })),
            all_time_humans: z.number().int(),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const link = await loadOwned(ctx, authOf(req).userId, req.params.id);
      const range = resolveDayRange(req.query);
      const s = await linkSummary(ctx.db, {
        linkId: link.id,
        fromDay: range.fromDay,
        toDay: range.toDay,
      });
      return {
        link_id: link.id,
        from: range.from,
        to: range.to,
        total: s.total,
        humans: s.humans,
        uniques: s.uniques,
        unique_ratio: s.humans > 0 ? Math.round((s.uniques / s.humans) * 10_000) / 10_000 : null,
        bots: s.bots,
        previews: s.previews,
        preview_apps: s.previewApps,
        all_time_humans: link.clickCount,
      };
    },
  );
}
