import { createHash } from 'node:crypto';
import type {
  CreateLinkInput,
  Link,
  LinkPatch,
  LinkSort,
  OwnedLink,
  SortDir,
} from '@encurtador/db';
import { writeThrough } from '@encurtador/db/cache';
import {
  linkRulesSchema,
  validateAlias,
  validateDestination,
  type DestinationErrorCode,
  type LinkRules,
} from '@encurtador/shared';
import { hash as argon2Hash } from '@node-rs/argon2';
import type { FastifyBaseLogger } from 'fastify';
import { ApiError, type FieldError } from '../../lib/problem';
import type { Ctx } from '../../types';
import type { CreateLinkBody, PatchLinkBody } from './schemas';

const DESTINATION_MESSAGES: Record<DestinationErrorCode, string> = {
  invalid_url: 'URL inválida',
  too_long: 'URL com mais de 4.096 caracteres',
  unsupported_protocol: 'só http e https',
  credentials: 'URL com usuário ou senha embutidos',
  private_host: 'destino em rede privada ou local',
  loop: 'destino num dos nossos domínios curtos (loop)',
};

const ALIAS_MESSAGES = {
  alias_format: 'de 3 a 64 caracteres: letras, números, _ e -, começando por letra ou número',
  alias_reserved: 'alias reservado',
} as const;

/** Destino validado e normalizado, ou o erro do campo. */
export function checkDestination(
  ctx: Ctx,
  raw: string,
  field: string,
  errors: FieldError[],
): string | null {
  const v = validateDestination(raw, { shortDomains: ctx.config.shortDomains });
  if (v.ok) return v.url;
  errors.push({ field, code: v.code, message: DESTINATION_MESSAGES[v.code] });
  return null;
}

/** Regras com a forma do `linkRulesSchema` e cada URL passando por `validateDestination`. */
function checkRules(ctx: Ctx, rules: unknown, errors: FieldError[]): LinkRules | null {
  const parsed = linkRulesSchema.safeParse(rules);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      errors.push({ field: ['rules', ...i.path].join('.'), code: i.code, message: i.message });
    }
    return null;
  }
  const out: LinkRules = {};
  if (parsed.data.geo) {
    out.geo = parsed.data.geo.map((r, i) => ({
      countries: [...new Set(r.countries)],
      url: checkDestination(ctx, r.url, `rules.geo.${i}.url`, errors) ?? r.url,
    }));
  }
  if (parsed.data.device) {
    out.device = parsed.data.device.map((r, i) => ({
      match: r.match,
      url: checkDestination(ctx, r.url, `rules.device.${i}.url`, errors) ?? r.url,
    }));
  }
  return out;
}

function checkExpiry(
  value: string | null | undefined,
  errors: FieldError[],
): Date | null | undefined {
  if (value === undefined || value === null) return value;
  const d = new Date(value);
  if (d.getTime() <= Date.now()) {
    errors.push({
      field: 'expires_at',
      code: 'past',
      message: 'a expiração precisa estar no futuro',
    });
  }
  return d;
}

export const hashPassword = (password: string) => argon2Hash(password);

/**
 * Validação semântica da criação (o formato já veio do Zod): destino, alias, regras e expiração.
 * Devolve a entrada de `createLink`, com a senha já em argon2id, ou lança 422 com `errors[]`.
 */
export async function prepareCreate(
  ctx: Ctx,
  userId: number,
  body: CreateLinkBody,
): Promise<CreateLinkInput> {
  const errors: FieldError[] = [];
  const destination = checkDestination(ctx, body.destination, 'destination', errors);
  if (body.alias !== undefined) {
    const v = validateAlias(body.alias);
    if (!v.ok) errors.push({ field: 'alias', code: v.code, message: ALIAS_MESSAGES[v.code] });
  }
  const rules = body.rules === undefined ? undefined : checkRules(ctx, body.rules, errors);
  const expiresAt = checkExpiry(body.expires_at, errors);
  if (errors.length > 0 || destination === null) {
    throw new ApiError('validation', 'o link não passou na validação', { errors });
  }
  const input: CreateLinkInput = { userId, destination };
  if (body.alias !== undefined) input.alias = body.alias;
  if (body.title !== undefined) input.title = body.title;
  if (body.redirect_type !== undefined) input.redirectType = body.redirect_type;
  if (body.cache_ttl !== undefined) input.cacheTtl = body.cache_ttl;
  if (expiresAt !== undefined) input.expiresAt = expiresAt;
  if (body.max_clicks !== undefined) input.maxClicks = body.max_clicks;
  if (body.forward_query !== undefined) input.forwardQuery = body.forward_query;
  if (rules) input.rules = rules;
  if (body.password) input.passwordHash = await hashPassword(body.password);
  return input;
}

/** O mesmo para o PATCH: só os campos presentes. */
export async function preparePatch(ctx: Ctx, body: PatchLinkBody): Promise<LinkPatch> {
  const errors: FieldError[] = [];
  const patch: LinkPatch = {};
  if (body.destination !== undefined) {
    const d = checkDestination(ctx, body.destination, 'destination', errors);
    if (d) patch.destination = d;
  }
  if (body.rules !== undefined) {
    const r = checkRules(ctx, body.rules, errors);
    if (r) patch.rules = r;
  }
  if (body.expires_at !== undefined) {
    const e = checkExpiry(body.expires_at, errors);
    if (e !== undefined) patch.expiresAt = e;
  }
  if (errors.length > 0)
    throw new ApiError('validation', 'o link não passou na validação', { errors });
  if (body.title !== undefined) patch.title = body.title;
  if (body.redirect_type !== undefined) patch.redirectType = body.redirect_type;
  if (body.cache_ttl !== undefined) patch.cacheTtl = body.cache_ttl;
  if (body.max_clicks !== undefined) patch.maxClicks = body.max_clicks;
  if (body.forward_query !== undefined) patch.forwardQuery = body.forward_query;
  if (body.status !== undefined) patch.status = body.status;
  if (body.password !== undefined) {
    patch.passwordHash = body.password === null ? null : await hashPassword(body.password);
  }
  return patch;
}

/** Write-through depois do commit (ADR 0002): falha no Redis não desfaz a escrita, só registra. */
export async function syncCache(
  ctx: Ctx,
  log: FastifyBaseLogger,
  slug: string,
  link: Link | null,
): Promise<void> {
  try {
    await writeThrough(ctx.redis, slug, link);
  } catch (err) {
    log.warn({ err: (err as Error).message, slug }, 'write-through falhou; o cache expira sozinho');
  }
}

export function serializeLink(ctx: Ctx, l: Link) {
  return {
    id: l.id,
    slug: l.slug,
    short_url: `${ctx.config.shortBaseUrl}/${l.slug}`,
    is_custom: l.isCustom,
    destination: l.destination,
    title: l.title,
    redirect_type: l.redirectType,
    cache_ttl: l.cacheTtl,
    status: l.status,
    is_expired: l.expiresAt !== null && l.expiresAt.getTime() <= Date.now(),
    expires_at: l.expiresAt?.toISOString() ?? null,
    max_clicks: l.maxClicks,
    has_password: l.passwordHash !== null,
    forward_query: l.forwardQuery,
    rules: (l.rules ?? {}) as Record<string, unknown>,
    created_at: l.createdAt.toISOString(),
    updated_at: l.updatedAt.toISOString(),
  };
}

export const serializeListItem = (ctx: Ctx, l: OwnedLink) => ({
  ...serializeLink(ctx, l),
  click_count: l.clickCount,
});

// ------------------------------------------------------------------ cursor

export interface ListFilters {
  q?: string | undefined;
  status?: string | undefined;
  created_from?: string | undefined;
  created_to?: string | undefined;
  has_password?: string | undefined;
  sort: LinkSort;
  order: SortDir;
}

interface CursorPayload {
  s: LinkSort;
  d: SortDir;
  v: string | number;
  i: number;
  /** Hash dos filtros: o cursor só vale para a mesma consulta. */
  f: string;
}

export const filtersHash = (f: ListFilters) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        f.q,
        f.status,
        f.created_from,
        f.created_to,
        f.has_password,
        f.sort,
        f.order,
      ]),
    )
    .digest('base64url')
    .slice(0, 16);

/** Cursor opaco (ADR 0004): base64url de `{ sort, dir, último valor, id, filtros }`. */
export const encodeCursor = (p: CursorPayload) =>
  Buffer.from(JSON.stringify(p)).toString('base64url');

export function decodeCursor(
  raw: string,
  filters: ListFilters,
): { value: string | number; id: number } {
  let p: CursorPayload;
  try {
    p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw new ApiError('invalid_cursor', 'cursor ilegível');
  }
  const valueOk =
    p.s === 'clicks' ? Number.isSafeInteger(p.v) : typeof p.v === 'string' && p.v.length <= 600;
  if (
    typeof p !== 'object' ||
    p === null ||
    !Number.isSafeInteger(p.i) ||
    !valueOk ||
    (p.s === 'created_at' && Number.isNaN(Date.parse(String(p.v))))
  ) {
    throw new ApiError('invalid_cursor', 'cursor ilegível');
  }
  if (p.f !== filtersHash(filters) || p.s !== filters.sort || p.d !== filters.order) {
    throw new ApiError('cursor_mismatch', 'o cursor foi gerado com outros filtros ou ordenação');
  }
  return { value: p.v, id: p.i };
}
