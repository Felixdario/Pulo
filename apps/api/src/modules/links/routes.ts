import {
  createLink,
  createLinks,
  getOwnedLink,
  InvalidAliasError,
  linkVersions,
  listLinks,
  SlugExhaustedError,
  SlugTakenError,
  softDeleteLink,
  updateLink,
  type CreateLinkInput,
  type MutateResult,
  type OwnedLink,
} from '@encurtador/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { etagList, linkEtag, parseLinkEtag } from '../../lib/etag';
import { ApiError, errorResponses, problemBody, type FieldError } from '../../lib/problem';
import { parseBound } from '../../lib/time';
import { authOf } from '../../plugins/security';
import { SECURITY } from '../../openapi';
import type { Ctx } from '../../types';
import {
  batchBody,
  batchResultSchema,
  createLinkBody,
  idParams,
  linkListItemSchema,
  linkSchema,
  listQuery,
  patchLinkBody,
} from './schemas';
import {
  decodeCursor,
  encodeCursor,
  filtersHash,
  prepareCreate,
  preparePatch,
  serializeLink,
  serializeListItem,
  syncCache,
  type ListFilters,
} from './service';

/** Link do usuário ou erro: 404 se não existe ou é de outro (não revelamos), 410 se apagado. */
export async function loadOwned(ctx: Ctx, userId: number, id: number): Promise<OwnedLink> {
  const link = await getOwnedLink(ctx.db, userId, id);
  if (!link) throw new ApiError('not_found', 'link não encontrado');
  if (link.deletedAt !== null) throw new ApiError('gone', 'este link foi apagado');
  return link;
}

/** `If-Match` → versão esperada (`undefined` sem o cabeçalho ou com `*`). Tag de outro link → 412. */
function expectedVersion(header: string | undefined, id: number): string | undefined {
  const tags = etagList(header);
  if (tags.length === 0 || tags.includes('*')) return undefined;
  for (const t of tags) {
    const parsed = parseLinkEtag(t);
    if (parsed && parsed.id === id) return parsed.version;
  }
  return '-1'; // nenhuma tag deste link: nunca casa
}

function unwrap(r: MutateResult): OwnedLink {
  if (r.kind === 'ok') return r.link;
  if (r.kind === 'not_found') throw new ApiError('not_found', 'link não encontrado');
  if (r.kind === 'gone') throw new ApiError('gone', 'este link foi apagado');
  throw new ApiError('precondition_failed', 'o link mudou; leia de novo e reaplique a edição', {
    headers: { etag: linkEtag(r.current.id, r.current.updatedUs) },
  });
}

const withEtag = (reply: FastifyReply, link: OwnedLink) =>
  reply.header('etag', linkEtag(link.id, link.updatedUs));

export function linkRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['links'];

  r.post(
    '/v1/links',
    {
      config: { scope: 'links:write', idempotent: true },
      schema: {
        tags,
        summary: 'Cria um link',
        description:
          'Valida o destino (http/https, sem rede privada, sem loop), o alias e cada URL das regras. Aceita `Idempotency-Key`.',
        security: SECURITY,
        headers: z.object({ 'idempotency-key': z.string().optional() }).loose(),
        body: createLinkBody,
        response: {
          201: linkSchema,
          ...errorResponses(400, 401, 403, 409, 422, 429),
        },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      const input = await prepareCreate(ctx, userId, req.body);
      let link;
      try {
        link = await createLink(ctx.db, input);
      } catch (err) {
        if (err instanceof SlugTakenError) {
          throw new ApiError('alias_taken', `o alias "${err.slug}" já está em uso`, {
            errors: [{ field: 'alias', code: 'slug_taken', message: 'alias em uso' }],
          });
        }
        if (err instanceof InvalidAliasError) throw new ApiError('validation', err.message);
        if (err instanceof SlugExhaustedError) throw new ApiError('slug_exhausted');
        throw err;
      }
      await syncCache(ctx, req.log, link.slug, link);
      const versions = await linkVersions(ctx.db, [link.id]);
      reply.header('location', `/v1/links/${link.id}`);
      reply.header('etag', linkEtag(link.id, versions.get(link.id)!));
      return reply.code(201).send(serializeLink(ctx, link));
    },
  );

  r.post(
    '/v1/links/batch',
    {
      config: { scope: 'links:write', idempotent: true },
      bodyLimit: 8 * 1024 * 1024,
      schema: {
        tags,
        summary: 'Cria até 1.000 links',
        description:
          'Responde **200** com um resultado por item, na ordem da entrada, cada um com o próprio `status` (201, 409 ou 422). ' +
          'Não usa 207 Multi-Status: ele é do WebDAV, cujo corpo é XML, e a requisição em si deu certo; o cliente lê `results[i].status`. ' +
          'Itens inválidos não impedem os válidos.',
        security: SECURITY,
        body: batchBody,
        response: { 200: batchResultSchema, ...errorResponses(400, 401, 403, 409, 422, 429) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const items = req.body.links;
      type Result = z.infer<typeof batchResultSchema>['results'][number];
      const results: Result[] = new Array(items.length);
      const valid: { index: number; input: CreateLinkInput }[] = [];

      const fail = (
        index: number,
        status: number,
        code: string,
        title: string,
        extra: { detail?: string; errors?: FieldError[] } = {},
      ) => {
        results[index] = { index, status, error: { code, title, ...extra } };
      };

      // Validação por item (Zod + semântica). Senhas em argon2id, em paralelo no pool do libuv.
      await Promise.all(
        items.map(async (raw, index) => {
          const parsed = createLinkBody.safeParse(raw);
          if (!parsed.success) {
            fail(index, 422, 'validation', 'Dados inválidos', {
              errors: parsed.error.issues.map((i) => ({
                field: i.path.join('.') || '(item)',
                code: i.code,
                message: i.message,
              })),
            });
            return;
          }
          try {
            valid.push({ index, input: await prepareCreate(ctx, userId, parsed.data) });
          } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            const p = problemBody(err.code, undefined, err.detail);
            fail(index, err.status, err.code, p.title, {
              detail: err.message,
              errors: err.extra.errors ?? [],
            });
          }
        }),
      );
      valid.sort((a, b) => a.index - b.index);

      const created = await createLinks(
        ctx.db,
        valid.map((v) => v.input),
      );
      created.forEach((c, k) => {
        const index = valid[k]!.index;
        if (c.ok) {
          results[index] = { index, status: 201, link: serializeLink(ctx, c.link) };
        } else if (c.code === 'slug_taken') {
          fail(index, 409, 'alias_taken', 'Alias em uso', {
            detail: `o alias "${c.slug}" já está em uso`,
          });
        } else if (c.code === 'slug_exhausted') {
          fail(index, 503, 'slug_exhausted', 'Nenhum slug livre; tente de novo');
        } else {
          fail(index, 422, 'validation', 'Dados inválidos', {
            errors: [{ field: 'alias', code: c.code, message: 'alias inválido' }],
          });
        }
      });
      // Write-through de todos os criados (SET incondicional, como em writeThrough).
      await Promise.all(
        created.flatMap((c) => (c.ok ? [syncCache(ctx, req.log, c.link.slug, c.link)] : [])),
      );
      const ok = results.filter((x) => x.status === 201).length;
      return { created: ok, failed: results.length - ok, results };
    },
  );

  r.get(
    '/v1/links',
    {
      config: { scope: 'links:read' },
      schema: {
        tags,
        summary: 'Lista os links',
        description:
          'Paginação por cursor (`next_cursor`), amarrado aos filtros: trocar um filtro com o mesmo cursor dá 422. ' +
          '`created_from`/`created_to` aceitam `AAAA-MM-DD` (dia UTC, inclusive) ou instante ISO. ETag fraco e 304.',
        security: SECURITY,
        querystring: listQuery,
        response: {
          200: z.object({
            data: z.array(linkListItemSchema),
            next_cursor: z.string().nullable(),
            has_more: z.boolean(),
          }),
          ...errorResponses(401, 403, 422, 429),
        },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const q = req.query;
      const order = q.order ?? (q.sort === 'title' ? 'asc' : 'desc');
      const filters: ListFilters = {
        q: q.q,
        status: q.status,
        created_from: q.created_from,
        created_to: q.created_to,
        has_password: q.has_password,
        sort: q.sort,
        order,
      };
      const after = q.cursor ? decodeCursor(q.cursor, filters) : undefined;
      const { items, hasMore } = await listLinks(ctx.db, {
        userId,
        sort: q.sort,
        dir: order,
        limit: q.limit,
        after,
        q: q.q,
        status: q.status,
        createdFrom: q.created_from ? parseBound(q.created_from, 'UTC', 'from') : undefined,
        createdTo: q.created_to ? parseBound(q.created_to, 'UTC', 'to') : undefined,
        hasPassword: q.has_password === undefined ? undefined : q.has_password === 'true',
      });
      const last = items.at(-1);
      return {
        data: items.map((l) => serializeListItem(ctx, l)),
        next_cursor:
          hasMore && last
            ? encodeCursor({
                s: q.sort,
                d: order,
                v: last.cursorValue,
                i: last.id,
                f: filtersHash(filters),
              })
            : null,
        has_more: hasMore,
      };
    },
  );

  r.get(
    '/v1/links/:id',
    {
      config: { scope: 'links:read' },
      schema: {
        tags,
        summary: 'Lê um link',
        description:
          'ETag forte (id + updated_at), usado no `If-Match` do PATCH; `If-None-Match` igual → 304.',
        security: SECURITY,
        params: idParams,
        response: { 200: linkSchema, ...errorResponses(401, 403, 404, 410, 429) },
      },
    },
    async (req, reply) => {
      const link = await loadOwned(ctx, authOf(req).userId, req.params.id);
      withEtag(reply, link);
      return serializeLink(ctx, link);
    },
  );

  r.patch(
    '/v1/links/:id',
    {
      config: { scope: 'links:write' },
      schema: {
        tags,
        summary: 'Edita um link',
        description:
          'Com `If-Match` (ETag do GET), uma edição concorrente dá 412 em vez de sobrescrever. Slug e alias não mudam: o link curto já pode estar impresso ou compartilhado.',
        security: SECURITY,
        params: idParams,
        headers: z.object({ 'if-match': z.string().optional() }).loose(),
        body: patchLinkBody,
        response: { 200: linkSchema, ...errorResponses(400, 401, 403, 404, 410, 412, 422, 429) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      const { id } = req.params;
      const patch = await preparePatch(ctx, req.body);
      const expected = expectedVersion(req.headers['if-match'], id);
      const link = unwrap(await updateLink(ctx.db, userId, id, patch, expected));
      await syncCache(ctx, req.log, link.slug, link);
      withEtag(reply, link);
      return serializeLink(ctx, link);
    },
  );

  r.delete(
    '/v1/links/:id',
    {
      config: { scope: 'links:write' },
      schema: {
        tags,
        summary: 'Apaga um link (soft delete)',
        description:
          'O slug nunca é reaproveitado. O redirect passa a responder 404 na hora (cache negativo).',
        security: SECURITY,
        params: idParams,
        headers: z.object({ 'if-match': z.string().optional() }).loose(),
        response: { 204: z.undefined(), ...errorResponses(401, 403, 404, 410, 412, 429) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      const { id } = req.params;
      const link = unwrap(
        await softDeleteLink(ctx.db, userId, id, expectedVersion(req.headers['if-match'], id)),
      );
      await syncCache(ctx, req.log, link.slug, null);
      return reply.code(204).send();
    },
  );
}
