import { generateSlug, validateAlias, type SlugGenerator } from '@encurtador/shared';
import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import { links, type Link, type LinkRules, type NewLink, type RedirectType } from './schema';
import type * as schema from './schema';

/** Banco ou transação: `createLink` funciona dentro de uma transação do chamador. */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

export const DEFAULT_MAX_ATTEMPTS = 5;
/** Linhas por INSERT multi-linha; ~13 parâmetros por linha, bem abaixo do limite de 65.535. */
const BATCH_CHUNK = 1000;
/** Re-sorteios locais por tentativa quando o slug já foi usado no próprio lote. */
const LOCAL_REDRAWS = 100;

export interface CreateLinkInput {
  destination: string;
  /** Alias escolhido pelo usuário. Ausente = slug aleatório. */
  alias?: string;
  userId?: number | null;
  title?: string | null;
  redirectType?: RedirectType;
  cacheTtl?: number;
  expiresAt?: Date | null;
  maxClicks?: number | null;
  passwordHash?: string | null;
  forwardQuery?: boolean;
  rules?: LinkRules;
}

export interface CreateLinkOptions {
  /** Gerador de slugs; recebe a tentativa (0-based). Padrão: BASE62, 7/7/7/8/8. */
  generate?: SlugGenerator;
  maxAttempts?: number;
}

export class SlugTakenError extends Error {
  override readonly name = 'SlugTakenError';
  constructor(readonly slug: string) {
    super(`o slug "${slug}" já está em uso`);
  }
}

export class SlugExhaustedError extends Error {
  override readonly name = 'SlugExhaustedError';
  constructor(readonly attempts: number) {
    super(`nenhum slug livre após ${attempts} tentativas`);
  }
}

export class InvalidAliasError extends Error {
  override readonly name = 'InvalidAliasError';
  constructor(
    readonly alias: string,
    readonly code: 'alias_format' | 'alias_reserved',
  ) {
    super(`alias inválido (${code}): "${alias}"`);
  }
}

export type CreateLinkErrorCode =
  'slug_taken' | 'slug_exhausted' | 'alias_format' | 'alias_reserved';

/** Resultado por item de `createLinks`, na mesma ordem da entrada. */
export type CreateLinkResult =
  { ok: true; link: Link } | { ok: false; code: CreateLinkErrorCode; slug?: string };

function toRow(input: CreateLinkInput, slug: string): NewLink {
  const row: NewLink = {
    slug,
    isCustom: input.alias !== undefined,
    destination: input.destination,
  };
  if (input.userId !== undefined) row.userId = input.userId;
  if (input.title !== undefined) row.title = input.title;
  if (input.redirectType !== undefined) row.redirectType = input.redirectType;
  if (input.cacheTtl !== undefined) row.cacheTtl = input.cacheTtl;
  if (input.expiresAt !== undefined) row.expiresAt = input.expiresAt;
  if (input.maxClicks !== undefined) row.maxClicks = input.maxClicks;
  if (input.passwordHash !== undefined) row.passwordHash = input.passwordHash;
  if (input.forwardQuery !== undefined) row.forwardQuery = input.forwardQuery;
  if (input.rules !== undefined) row.rules = input.rules;
  return row;
}

/**
 * Compara por ponto de código, que é a mesma ordem dos bytes UTF-8 e do `COLLATE "C"`. Não usa `<`
 * de strings (unidades UTF-16 divergem para caracteres fora do BMP) nem `localeCompare`.
 */
export function compareBytes(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

function checkAlias(alias: string): void {
  const v = validateAlias(alias);
  if (!v.ok) throw new InvalidAliasError(alias, v.code);
}

/**
 * Cria um link (ADR 0001). Cada tentativa é um único `INSERT … ON CONFLICT (slug) DO NOTHING
 * RETURNING`, sem SELECT antes: quem decide a unicidade é o índice `links_slug_key`.
 * - Alias em uso → `SlugTakenError`, sem nova tentativa.
 * - Slug aleatório em uso → sorteia de novo, até `maxAttempts`; esgotou → `SlugExhaustedError`.
 */
export async function createLink(
  db: Executor,
  input: CreateLinkInput,
  opts: CreateLinkOptions = {},
): Promise<Link> {
  const generate = opts.generate ?? generateSlug;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (input.alias !== undefined) {
    checkAlias(input.alias);
    const [link] = await db
      .insert(links)
      .values(toRow(input, input.alias))
      .onConflictDoNothing({ target: links.slug })
      .returning();
    if (!link) throw new SlugTakenError(input.alias);
    return link;
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [link] = await db
      .insert(links)
      .values(toRow(input, generate(attempt)))
      .onConflictDoNothing({ target: links.slug })
      .returning();
    if (link) return link;
  }
  throw new SlugExhaustedError(maxAttempts);
}

/**
 * Cria vários links numa única transação. A cada rodada, um INSERT multi-linha com
 * `ON CONFLICT (slug) DO NOTHING RETURNING` (em blocos de 1.000); só os itens aleatórios que não
 * voltaram no RETURNING são sorteados de novo. Como DO NOTHING não aborta a transação, um alias
 * em uso vira erro daquele item sem derrubar os outros.
 *
 * Dentro do próprio lote, o primeiro item com um alias fica com ele; repetições seguintes recebem
 * `slug_taken` sem ir ao banco. Slugs aleatórios nunca repetem um slug já usado no lote.
 * "Tentativa" é um INSERT do item, como em `createLink`: até `maxAttempts`, com o comprimento que o
 * gerador der para aquela tentativa.
 *
 * Só conflito de slug é tratado por item. Qualquer outra violação (CHECK de `redirect_type`,
 * `max_clicks`, `status`, `cache_ttl`, FK de `user_id`) lança erro e **aborta o lote inteiro**
 * (rollback). Por isso a API valida cada item antes de chamar esta função: `validateDestination`,
 * faixas dos campos e existência do usuário; os itens inválidos nem chegam aqui.
 *
 * Cada rodada é ordenada por slug em ordem de bytes antes do INSERT, para evitar deadlock entre
 * lotes concorrentes com slugs em comum.
 */
export async function createLinks(
  db: Executor,
  inputs: readonly CreateLinkInput[],
  opts: CreateLinkOptions = {},
): Promise<CreateLinkResult[]> {
  const generate = opts.generate ?? generateSlug;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const results = new Array<CreateLinkResult | undefined>(inputs.length);
  if (inputs.length === 0) return [];

  /** Slugs já usados neste lote (inseridos ou recusados): não adianta tentá-los de novo. */
  const claimed = new Set<string>();
  const attempts = new Array<number>(inputs.length).fill(0);
  let candidates = new Map<number, string>(); // índice → slug desta rodada

  inputs.forEach((input, i) => {
    if (input.alias === undefined) return;
    const v = validateAlias(input.alias);
    if (!v.ok) results[i] = { ok: false, code: v.code, slug: input.alias };
    else if (claimed.has(input.alias))
      results[i] = { ok: false, code: 'slug_taken', slug: input.alias };
    else {
      claimed.add(input.alias);
      candidates.set(i, input.alias);
    }
  });

  const drawFor = (i: number): void => {
    while (attempts[i]! < maxAttempts) {
      // Sorteio que repete um slug do próprio lote não foi ao banco: sorteia de novo na mesma
      // tentativa, até LOCAL_REDRAWS vezes; só então conta como tentativa gasta.
      for (let k = 0; k < LOCAL_REDRAWS; k++) {
        const slug = generate(attempts[i]!);
        if (!claimed.has(slug)) {
          claimed.add(slug);
          candidates.set(i, slug);
          return;
        }
      }
      attempts[i]!++;
    }
    results[i] = { ok: false, code: 'slug_exhausted' };
  };

  return db.transaction(async (tx) => {
    inputs.forEach((input, i) => {
      if (input.alias === undefined) drawFor(i);
    });

    while (candidates.size > 0) {
      // Ordem de bytes (= COLLATE "C") em toda a rodada, antes de dividir em blocos: dois lotes
      // concorrentes com slugs em comum disputam os mesmos slugs na mesma ordem, então um espera o
      // outro em vez de formar um ciclo (deadlock 40P01). A ordem dos resultados não muda.
      const round = [...candidates].sort(([, a], [, b]) => compareBytes(a, b));
      candidates = new Map();
      const bySlug = new Map(round.map(([i, slug]) => [slug, i]));

      for (let start = 0; start < round.length; start += BATCH_CHUNK) {
        const chunk = round.slice(start, start + BATCH_CHUNK);
        const inserted = await tx
          .insert(links)
          .values(chunk.map(([i, slug]) => toRow(inputs[i]!, slug)))
          .onConflictDoNothing({ target: links.slug })
          .returning();
        for (const link of inserted) {
          const i = bySlug.get(link.slug)!;
          results[i] = { ok: true, link };
          bySlug.delete(link.slug);
        }
      }

      // O que sobrou em bySlug colidiu com uma linha que já existia (ou de outra transação).
      for (const [slug, i] of bySlug) {
        if (inputs[i]!.alias !== undefined) {
          results[i] = { ok: false, code: 'slug_taken', slug };
        } else {
          attempts[i]!++;
          drawFor(i);
        }
      }
    }

    return results.map((r) => r!);
  });
}

/**
 * Linha do link pelo slug exato (COLLATE "C"), inclusive apagado ou desativado: o redirect precisa
 * saber que ele existe para gravar o cache negativo. Uma query, pelo índice `links_slug_key`.
 */
export async function findLinkBySlug(db: Executor, slug: string): Promise<Link | null> {
  const [link] = await db.select().from(links).where(eq(links.slug, slug)).limit(1);
  return link ?? null;
}

/** Cliques humanos já processados pelo worker (`links.click_count`); inicializa o limite no Redis. */
export async function getClickCount(db: Executor, linkId: number): Promise<number> {
  const [row] = await db
    .select({ n: links.clickCount })
    .from(links)
    .where(eq(links.id, linkId))
    .limit(1);
  return row?.n ?? 0;
}
