import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomToken } from '../../lib/crypto';
import { ApiError, errorResponses } from '../../lib/problem';
import { SECURITY } from '../../openapi';
import { authOf } from '../../plugins/security';
import type { Ctx } from '../../types';
import { loadOwned } from '../links/routes';
import type { LiveHub } from './hub';

const ticketKey = (t: string) => `lt:${t}`;

export function liveRoutes(app: FastifyInstance, ctx: Ctx, hub: LiveHub) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['live'];
  const streams = new Set<ServerResponse>();

  // Antes de fechar o servidor: SSE abertos seguram o close() para sempre.
  app.addHook('preClose', async () => {
    for (const s of streams) s.end();
    streams.clear();
  });

  r.post(
    '/v1/live/ticket',
    {
      config: { scope: 'stats:read' },
      schema: {
        tags,
        summary: 'Ticket de uso único para abrir o SSE',
        description:
          'O EventSource não envia cabeçalhos; o ticket (30 s, uso único, no Redis) evita pôr o JWT na URL, onde iria para os logs.',
        security: SECURITY,
        response: {
          200: z
            .object({ ticket: z.string(), expires_in: z.number().int() })
            .meta({ example: { ticket: 'q2V0…', expires_in: 30 } }),
          ...errorResponses(401, 403, 429),
        },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      const ticket = randomToken(24);
      await ctx.redis.set(ticketKey(ticket), String(userId), 'EX', ctx.config.liveTicketTtlSeconds);
      reply.header('cache-control', 'no-store');
      return { ticket, expires_in: ctx.config.liveTicketTtlSeconds };
    },
  );

  r.get(
    '/v1/live',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Cliques ao vivo (text/event-stream)',
        description:
          'Eventos `click` com `{ link_id, humans, total }` por lote do worker, filtrados por `link_id` se dado; evento `heartbeat` (sem dados) a cada 15 s, para o cliente notar uma conexão morta. O ticket é consumido na abertura (GETDEL).',
        querystring: z
          .object({
            ticket: z.string().min(1).max(200),
            link_id: z.coerce.number().int().positive().optional(),
          })
          .strict(),
        response: {
          200: {
            description: 'Fluxo SSE',
            content: { 'text/event-stream': { schema: z.string() } },
          },
          ...errorResponses(401, 404, 410, 422, 429),
        },
      },
    },
    async (req, reply) => {
      const owner = await ctx.redis.getdel(ticketKey(req.query.ticket));
      if (!owner) throw new ApiError('invalid_ticket');
      const userId = Number(owner);
      const linkId = req.query.link_id;
      if (linkId !== undefined) await loadOwned(ctx, userId, linkId);

      const raw = reply.raw;
      let closed = false;
      let unsubscribe: (() => Promise<void>) | null = null;
      const send = (chunk: string) => {
        if (!closed) raw.write(chunk);
      };

      reply.hijack();
      const headers: Record<string, string | number | string[]> = {};
      for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v;
      raw.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      streams.add(raw);

      // Evento nomeado, não comentário: o EventSource não expõe comentários, e o cliente precisa ver
      // o heartbeat para notar uma conexão que morreu sem fechar (um proxy no meio segura o socket).
      const heartbeat = setInterval(
        () => send('event: heartbeat\ndata: \n\n'),
        ctx.config.liveHeartbeatMs,
      );
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        streams.delete(raw);
        void unsubscribe?.();
      };
      req.raw.on('close', cleanup);
      raw.on('close', cleanup);

      unsubscribe = await hub.subscribe(`${ctx.config.liveChannelPrefix}${userId}`, (message) => {
        if (linkId !== undefined) {
          try {
            if ((JSON.parse(message) as { link_id?: number }).link_id !== linkId) return;
          } catch {
            return;
          }
        }
        send(`event: click\ndata: ${message}\n\n`);
      });
      if (closed) await unsubscribe();
      send(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ link_id: linkId ?? null })}\n\n`);
    },
  );
}
