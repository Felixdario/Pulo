import { and, eq, getTableColumns, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { Executor } from './links';
import { links, type Link, type NewLink } from './schema';

/**
 * Leitura e escrita de links pela API (ADR 0004). `updatedUs` é `updated_at` em microssegundos
 * (texto, sem perder precisão como um `Date` do JS perderia) e é a base do ETag forte de `If-Match`.
 */
export type OwnedLink = Link & { updatedUs: string };

const updatedUs = sql<string>`(extract(epoch from ${links.updatedAt}) * 1000000)::bigint::text`;
const withVersion = { ...getTableColumns(links), updatedUs };

/** Link do usuário pelo id, inclusive apagado (a API responde 410 ao dono). Outro dono = null. */
export async function getOwnedLink(
  db: Executor,
  userId: number,
  id: number,
): Promise<OwnedLink | null> {
  const [row] = await db
    .select(withVersion)
    .from(links)
    .where(and(eq(links.id, id), eq(links.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function getLinkVersion(db: Executor, id: number): Promise<OwnedLink | null> {
  const [row] = await db.select(withVersion).from(links).where(eq(links.id, id)).limit(1);
  return row ?? null;
}

export type LinkSort = 'created_at' | 'clicks' | 'title';
export type SortDir = 'asc' | 'desc';
export type LinkStatusFilter = 'active' | 'disabled' | 'expired';

export interface ListLinksParams {
  userId: number;
  sort: LinkSort;
  dir: SortDir;
  /** 1..100; a função busca `limit + 1` para saber se há próxima página. */
  limit: number;
  /** Último item da página anterior: valor da ordenação (como veio em `cursorValue`) e id. */
  after?: { value: string | number; id: number } | undefined;
  q?: string | undefined;
  status?: LinkStatusFilter | undefined;
  createdFrom?: Date | undefined;
  createdTo?: Date | undefined;
  hasPassword?: boolean | undefined;
}

export interface ListLinksResult {
  items: (OwnedLink & { cursorValue: string | number })[];
  hasMore: boolean;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Expressão de ordenação: a mesma no ORDER BY, no cursor e nos índices `links_user_*_idx`. */
function sortExpr(sort: LinkSort): SQL {
  if (sort === 'clicks') return sql`${links.clickCount}`;
  if (sort === 'title') return sql`coalesce(${links.title}, '')`;
  return sql`${links.createdAt}`;
}

/**
 * Valor do cursor como texto exato: `created_at` em ISO com microssegundos (o `Date` do JS só tem
 * milissegundos e faria a paginação pular ou repetir linhas criadas no mesmo milissegundo).
 */
function cursorExpr(sort: LinkSort): SQL {
  if (sort === 'created_at') {
    return sql`to_char(${links.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  }
  return sortExpr(sort);
}

function afterValue(sort: LinkSort, value: string | number): SQL {
  if (sort === 'created_at') return sql`${String(value)}::timestamptz`;
  if (sort === 'clicks') return sql`${Number(value)}::bigint`;
  return sql`${String(value)}::text`;
}

/**
 * Paginação por keyset: `(ordem, id) < (último valor, último id)` (ou `>` em ordem crescente). Uma
 * linha inserida depois do início não desloca as páginas seguintes, ao contrário de OFFSET.
 */
export async function listLinks(db: Executor, p: ListLinksParams): Promise<ListLinksResult> {
  const expr = sortExpr(p.sort);
  const conds: SQL[] = [sql`${links.userId} = ${p.userId}`, sql`${links.deletedAt} IS NULL`];
  if (p.after) {
    const op = p.dir === 'desc' ? sql`<` : sql`>`;
    conds.push(
      sql`(${expr}, ${links.id}) ${op} (${afterValue(p.sort, p.after.value)}, ${p.after.id}::bigint)`,
    );
  }
  if (p.q) {
    const like = `%${escapeLike(p.q)}%`;
    conds.push(
      sql`(${links.title} ILIKE ${like} OR ${links.slug} ILIKE ${like} OR ${links.destination} ILIKE ${like})`,
    );
  }
  if (p.status === 'active') {
    conds.push(
      sql`${links.status} = 'active' AND (${links.expiresAt} IS NULL OR ${links.expiresAt} > now())`,
    );
  } else if (p.status === 'disabled') {
    conds.push(sql`${links.status} = 'disabled'`);
  } else if (p.status === 'expired') {
    conds.push(sql`${links.expiresAt} <= now()`);
  }
  if (p.createdFrom) conds.push(sql`${links.createdAt} >= ${p.createdFrom.toISOString()}`);
  if (p.createdTo) conds.push(sql`${links.createdAt} < ${p.createdTo.toISOString()}`);
  if (p.hasPassword !== undefined) {
    conds.push(p.hasPassword ? isNotNull(links.passwordHash) : isNull(links.passwordHash));
  }

  // DESC NULLS LAST / ASC NULLS FIRST casam com os índices gerados (colunas NOT NULL de qualquer
  // jeito; a grafia só deixa o planejador usar o índice nos dois sentidos).
  const order =
    p.dir === 'desc'
      ? sql`${expr} DESC NULLS LAST, ${links.id} DESC NULLS LAST`
      : sql`${expr} ASC NULLS FIRST, ${links.id} ASC NULLS FIRST`;

  const rows = await db
    .select({ ...withVersion, cursorValue: cursorExpr(p.sort) })
    .from(links)
    .where(and(...conds))
    .orderBy(order)
    .limit(p.limit + 1);
  const hasMore = rows.length > p.limit;
  const items = rows.slice(0, p.limit).map((r) => ({
    ...r,
    cursorValue:
      p.sort === 'clicks' ? Number(r.cursorValue as unknown) : String(r.cursorValue as unknown),
  }));
  return { items, hasMore };
}

export type LinkPatch = Partial<
  Pick<
    NewLink,
    | 'destination'
    | 'title'
    | 'redirectType'
    | 'cacheTtl'
    | 'status'
    | 'expiresAt'
    | 'maxClicks'
    | 'passwordHash'
    | 'forwardQuery'
    | 'rules'
  >
>;

export type MutateResult =
  | { kind: 'ok'; link: OwnedLink }
  | { kind: 'not_found' }
  | { kind: 'gone' }
  | { kind: 'precondition_failed'; current: OwnedLink };

/** Distingue por que um UPDATE condicional não pegou nenhuma linha. */
async function explainMiss(db: Executor, userId: number, id: number): Promise<MutateResult> {
  const cur = await getOwnedLink(db, userId, id);
  if (!cur) return { kind: 'not_found' };
  if (cur.deletedAt !== null) return { kind: 'gone' };
  return { kind: 'precondition_failed', current: cur };
}

const versionMatches = (expected: string | undefined): SQL | undefined =>
  expected === undefined ? undefined : sql`${updatedUs} = ${expected}`;

/**
 * UPDATE condicional numa instrução só: dono, não apagado e, com `If-Match`, a mesma versão. Duas
 * abas editando juntas: a segunda recebe `precondition_failed` em vez de sobrescrever a primeira.
 * `clock_timestamp()` garante versão nova mesmo dentro da mesma transação.
 */
export async function updateLink(
  db: Executor,
  userId: number,
  id: number,
  patch: LinkPatch,
  expectedVersion?: string,
): Promise<MutateResult> {
  const [row] = await db
    .update(links)
    .set({ ...patch, updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(links.id, id),
        eq(links.userId, userId),
        isNull(links.deletedAt),
        versionMatches(expectedVersion),
      ),
    )
    .returning(withVersion);
  return row ? { kind: 'ok', link: row } : explainMiss(db, userId, id);
}

/** Soft delete (`deleted_at`). O slug continua ocupado para sempre (ADR 0001). */
export async function softDeleteLink(
  db: Executor,
  userId: number,
  id: number,
  expectedVersion?: string,
): Promise<MutateResult> {
  const [row] = await db
    .update(links)
    .set({ deletedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(links.id, id),
        eq(links.userId, userId),
        isNull(links.deletedAt),
        versionMatches(expectedVersion),
      ),
    )
    .returning(withVersion);
  return row ? { kind: 'ok', link: row } : explainMiss(db, userId, id);
}

/** Versão (`updatedUs`) de links recém-criados, para o ETag da resposta 201. */
export async function linkVersions(db: Executor, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: links.id, updatedUs })
    .from(links)
    .where(sql`${links.id} = ANY(${`{${ids.join(',')}}`}::bigint[])`);
  return new Map(rows.map((r) => [r.id, r.updatedUs]));
}
