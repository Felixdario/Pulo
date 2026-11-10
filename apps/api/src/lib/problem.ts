import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * Erros em `application/problem+json` (RFC 9457, ADR 0004). `type` é uma URI estável por código;
 * `code` repete o código para o cliente decidir sem analisar a URI.
 */
export const PROBLEM_BASE = 'https://encurta.dev/problems/';

const TITLES = {
  bad_request: [400, 'Requisição malformada'],
  unauthorized: [401, 'Não autenticado'],
  invalid_credentials: [401, 'E-mail ou senha incorretos'],
  invalid_refresh: [401, 'Sessão expirada ou revogada'],
  invalid_ticket: [401, 'Ticket inválido ou já usado'],
  insufficient_scope: [403, 'Escopo insuficiente'],
  session_required: [403, 'Esta rota exige a sessão do dashboard'],
  csrf: [403, 'Cabeçalho X-Requested-With ausente ou inválido'],
  not_found: [404, 'Não encontrado'],
  method_not_allowed: [405, 'Método não permitido'],
  alias_taken: [409, 'Alias em uso'],
  email_taken: [409, 'E-mail já cadastrado'],
  idempotency_in_progress: [409, 'Requisição com esta Idempotency-Key ainda em andamento'],
  gone: [410, 'Link apagado'],
  precondition_failed: [412, 'O recurso mudou desde a sua última leitura'],
  payload_too_large: [413, 'Corpo grande demais'],
  unsupported_media_type: [415, 'Content-Type não suportado'],
  validation: [422, 'Dados inválidos'],
  idempotency_mismatch: [422, 'Idempotency-Key reutilizada com outro corpo'],
  invalid_cursor: [422, 'Cursor inválido'],
  cursor_mismatch: [422, 'Cursor de outra consulta'],
  range_too_large: [422, 'Intervalo grande demais'],
  preview_blocked: [422, 'Destino não permitido para a prévia'],
  rate_limited: [429, 'Muitas requisições'],
  internal: [500, 'Erro interno'],
  upstream_error: [502, 'Não foi possível buscar o destino'],
  slug_exhausted: [503, 'Nenhum slug livre; tente de novo'],
} as const satisfies Record<string, readonly [number, string]>;

export type ProblemCode = keyof typeof TITLES;

export interface FieldError {
  /** Caminho do campo (`destination`, `rules.geo.0.url`, `query.limit`). */
  field: string;
  code: string;
  message: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ProblemCode;
  errors?: FieldError[];
  [extra: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ProblemCode,
    readonly detail?: string,
    readonly extra: { errors?: FieldError[]; headers?: Record<string, string> } & Record<
      string,
      unknown
    > = {},
  ) {
    super(detail ?? TITLES[code][1]);
    this.status = TITLES[code][0];
  }
}

export const statusOf = (code: ProblemCode) => TITLES[code][0];

export function problemBody(
  code: ProblemCode,
  instance: string | undefined,
  detail?: string,
  extra: Record<string, unknown> = {},
): Problem {
  const rest = { ...extra };
  delete rest.headers;
  const p: Problem = {
    type: `${PROBLEM_BASE}${code}`,
    title: TITLES[code][1],
    status: TITLES[code][0],
    code,
    ...rest,
  };
  if (detail !== undefined) p.detail = detail;
  if (instance !== undefined) p.instance = instance;
  return p;
}

export const instanceOf = (req: FastifyRequest) => req.url.split('?')[0];

/** Envia o problem como string: não passa pelo serializador da rota. */
export function sendProblem(
  req: FastifyRequest,
  reply: FastifyReply,
  code: ProblemCode,
  detail?: string,
  extra: Record<string, unknown> = {},
) {
  const body = problemBody(code, instanceOf(req), detail, extra);
  return reply
    .code(body.status)
    .header('cache-control', 'no-store')
    .type('application/problem+json; charset=utf-8')
    .send(JSON.stringify(body));
}

// ------------------------------------------------------------------ OpenAPI

export const fieldErrorSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
});

export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: z.string(),
    errors: z.array(fieldErrorSchema).optional(),
  })
  .meta({
    id: 'Problem',
    description: 'Erro no formato application/problem+json (RFC 9457).',
    example: {
      type: `${PROBLEM_BASE}validation`,
      title: 'Dados inválidos',
      status: 422,
      code: 'validation',
      instance: '/v1/links',
      errors: [{ field: 'destination', code: 'private_host', message: 'destino em rede privada' }],
    },
  });

const problemResponse = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: problemSchema } },
});

const DESCRIPTIONS: Record<number, string> = {
  400: 'JSON malformado',
  401: 'Não autenticado',
  403: 'Sem o escopo necessário',
  404: 'Inexistente ou de outro usuário',
  409: 'Conflito (alias em uso, Idempotency-Key em andamento)',
  410: 'Link apagado (só para o dono)',
  412: 'If-Match divergente',
  422: 'Validação',
  429: 'Rate limit',
  502: 'Falha ao buscar o destino',
};

/** Respostas de erro documentadas no OpenAPI. */
export function errorResponses(...statuses: number[]) {
  return Object.fromEntries(
    statuses.map((s) => [s, problemResponse(DESCRIPTIONS[s] ?? 'Erro')]),
  ) as Record<number, ReturnType<typeof problemResponse>>;
}
