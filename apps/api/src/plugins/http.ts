import {
  completeIdempotencyKey,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
} from '@encurtador/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { sha256, stableStringify } from '../lib/crypto';
import { weakEtag, weakMatch } from '../lib/etag';
import { ApiError, sendProblem, type FieldError, type ProblemCode } from '../lib/problem';
import type { Ctx } from '../types';

const CONTEXT_PREFIX: Record<string, string> = {
  body: '',
  querystring: 'query.',
  params: 'params.',
  headers: 'headers.',
};

interface ZodLikeIssue {
  keyword: string;
  instancePath: string;
  message: string;
}

/** Problemas do Zod → `errors[]` com o caminho do campo em pontos (`rules.geo.0.url`). */
function fieldErrors(issues: ZodLikeIssue[], context: string | undefined): FieldError[] {
  const prefix = CONTEXT_PREFIX[context ?? 'body'] ?? '';
  return issues.map((i) => ({
    field:
      `${prefix}${i.instancePath.replace(/^\//, '').replaceAll('/', '.')}`.replace(/\.$/, '') ||
      '(corpo)',
    code: i.keyword,
    message: i.message,
  }));
}

const FASTIFY_CODES: Record<string, ProblemCode> = {
  FST_ERR_CTP_INVALID_JSON_BODY: 'bad_request',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'bad_request',
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'bad_request',
};

/** problem+json para tudo: erros da aplicação, do Zod (422), do parser (400/413/415) e o 404. */
export function registerErrors(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.extra.headers ?? {})) reply.header(k, v);
      // `problemBody` descarta `extra.headers`, que já foram para a resposta.
      return sendProblem(req, reply, err.code, err.detail, err.extra);
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return sendProblem(req, reply, 'validation', 'a requisição não passou na validação', {
        errors: fieldErrors(err.validation as unknown as ZodLikeIssue[], err.validationContext),
      });
    }
    const e = err as Error & { code?: string; statusCode?: number };
    const mapped = e.code ? FASTIFY_CODES[e.code] : undefined;
    if (mapped) return sendProblem(req, reply, mapped, e.message);
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      // Outros 4xx do Fastify (ex.: cabeçalho inválido): mantém o status com o problem genérico.
      req.log.info({ err: { message: e.message, code: e.code } }, 'erro 4xx do Fastify');
      return sendProblem(req, reply, 'bad_request', e.message);
    }
    req.log.error({ err }, 'erro interno');
    return sendProblem(req, reply, 'internal');
  });

  app.setNotFoundHandler((req, reply) =>
    sendProblem(
      req,
      reply,
      'not_found',
      `nenhuma rota para ${req.method} ${req.url.split('?')[0]}`,
    ),
  );
}

/**
 * ETag fraco do corpo em toda leitura 200 (ADR 0004) e 304 para `If-None-Match` igual. Rotas que
 * já definem um ETag (forte, como o do link) só ganham a comparação.
 */
export function registerEtag(app: FastifyInstance) {
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return payload;
    if (reply.statusCode !== 200) return payload;
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
    let etag = reply.getHeader('etag') as string | undefined;
    if (!etag) {
      etag = weakEtag(payload);
      reply.header('etag', etag);
    }
    if (weakMatch(req.headers['if-none-match'], etag)) {
      reply.code(304);
      reply.removeHeader('content-type');
      reply.removeHeader('content-length');
      return '';
    }
    return payload;
  });
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const REPLAY_HEADERS = ['content-type', 'location', 'etag'];

/**
 * `Idempotency-Key` (ADR 0004) nas rotas com `config.idempotent`:
 * - preHandler (depois da validação): reserva com INSERT … ON CONFLICT DO NOTHING; repetição com o
 *   mesmo corpo devolve a resposta gravada (`Idempotent-Replayed: true`); outro corpo → 422; ainda
 *   em andamento → 409;
 * - onSend: resposta 2xx é gravada; qualquer outra solta a reserva (o cliente pode tentar de novo);
 * - onResponse: se a resposta não chegou ao onSend (conexão caiu), solta também.
 */
export function registerIdempotency(app: FastifyInstance, ctx: Ctx) {
  app.decorateRequest('idempotency', null);

  const requestHash = (req: FastifyRequest) =>
    sha256(`${req.method} ${req.routeOptions.url}\n${stableStringify(req.body ?? null)}`);

  app.addHook('preHandler', async (req, reply) => {
    if (!req.routeOptions.config.idempotent) return;
    const raw = req.headers['idempotency-key'];
    if (raw === undefined) return;
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new ApiError('validation', 'Idempotency-Key inválida', {
        errors: [
          {
            field: 'headers.idempotency-key',
            code: 'format',
            message: '1 a 255 caracteres ASCII visíveis',
          },
        ],
      });
    }
    const userId = req.auth?.userId;
    if (userId === undefined) return;
    const r = await reserveIdempotencyKey(ctx.db, userId, key, requestHash(req));
    if (r.kind === 'reserved') {
      req.idempotency = { userId, key, finished: false };
      return;
    }
    if (r.kind === 'processing') throw new ApiError('idempotency_in_progress');
    if (r.kind === 'mismatch') {
      throw new ApiError('idempotency_mismatch', 'a chave já foi usada com outro corpo ou rota');
    }
    for (const [k, v] of Object.entries(r.response.headers)) reply.header(k, v);
    reply.header('idempotent-replayed', 'true');
    return reply.code(r.response.statusCode).send(r.response.body);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const idem = req.idempotency;
    if (!idem || idem.finished) return payload;
    idem.finished = true;
    const status = reply.statusCode;
    if (status >= 200 && status < 300 && (typeof payload === 'string' || payload === undefined)) {
      const headers: Record<string, string> = {};
      for (const h of REPLAY_HEADERS) {
        const v = reply.getHeader(h);
        if (v !== undefined) headers[h] = String(v);
      }
      await completeIdempotencyKey(ctx.db, idem.userId, idem.key, {
        statusCode: status,
        headers,
        body: payload ?? '',
      });
    } else {
      await releaseIdempotencyKey(ctx.db, idem.userId, idem.key);
    }
    return payload;
  });

  app.addHook('onResponse', async (req) => {
    const idem = req.idempotency;
    if (idem && !idem.finished) {
      idem.finished = true;
      await releaseIdempotencyKey(ctx.db, idem.userId, idem.key).catch(() => {});
    }
  });
}
