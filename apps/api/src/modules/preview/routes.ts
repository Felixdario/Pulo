import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sha256 } from '../../lib/crypto';
import { ApiError, errorResponses } from '../../lib/problem';
import { SECURITY } from '../../openapi';
import type { Ctx } from '../../types';
import { createFetcher, PreviewError, type Resolver } from './fetcher';
import { parseMeta } from './parse';

const previewSchema = z
  .object({
    url: z.string(),
    final_url: z.string(),
    redirects: z.number().int(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    image: z.string().nullable(),
    favicon: z.string().nullable(),
    site_name: z.string().nullable(),
  })
  .meta({
    id: 'Preview',
    example: {
      url: 'https://exemplo.com/',
      final_url: 'https://www.exemplo.com/',
      redirects: 1,
      title: 'Exemplo',
      description: 'Um site de exemplo',
      image: 'https://www.exemplo.com/og.png',
      favicon: 'https://www.exemplo.com/favicon.ico',
      site_name: 'Exemplo',
    },
  });

export interface PreviewDeps {
  resolve?: Resolver;
  isAllowedAddress?: (ip: string) => boolean;
}

export function previewRoutes(app: FastifyInstance, ctx: Ctx, deps: PreviewDeps) {
  const { preview } = ctx.config;
  const fetchPage = createFetcher({
    shortDomains: ctx.config.shortDomains,
    timeoutMs: preview.timeoutMs,
    maxBytes: preview.maxBytes,
    maxRedirects: preview.maxRedirects,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.isAllowedAddress ? { isAllowedAddress: deps.isAllowedAddress } : {}),
  });

  app.withTypeProvider<ZodTypeProvider>().get(
    '/v1/preview',
    {
      config: { scope: 'links:write' },
      schema: {
        tags: ['preview'],
        summary: 'Título, descrição, imagem og e favicon do destino',
        description:
          'Buscador seguro: DNS resolvido e IP fixado (recusa endereço não público), até 3 redirecionamentos revalidados, 3 s, só text/html, até 512 KB. Cache de 1 h.',
        security: SECURITY,
        querystring: z.object({ url: z.string().min(1).max(4096) }).strict(),
        response: { 200: previewSchema, ...errorResponses(401, 403, 422, 429, 502) },
      },
    },
    async (req) => {
      const { url } = req.query;
      const cacheKey = `pv:${sha256(url)}`;
      const cached = await ctx.redis.get(cacheKey).catch(() => null);
      if (cached) return JSON.parse(cached) as z.infer<typeof previewSchema>;
      let page;
      try {
        page = await fetchPage(url);
      } catch (err) {
        if (!(err instanceof PreviewError)) throw err;
        const blocked = err.code === 'private_address' || err.code === 'invalid_url';
        throw new ApiError(blocked ? 'preview_blocked' : 'upstream_error', err.message, {
          reason: err.code,
        });
      }
      const meta = parseMeta(page.html, page.finalUrl);
      const body = {
        url,
        final_url: page.finalUrl,
        redirects: page.redirects,
        title: meta.title,
        description: meta.description,
        image: meta.image,
        favicon: meta.favicon,
        site_name: meta.siteName,
      };
      await ctx.redis
        .set(cacheKey, JSON.stringify(body), 'EX', preview.cacheTtlSeconds)
        .catch(() => {});
      return body;
    },
  );
}
