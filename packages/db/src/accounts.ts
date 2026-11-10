import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Executor } from './links';
import {
  apiKeys,
  idempotencyKeys,
  refreshTokens,
  users,
  type ApiKey,
  type ApiScope,
  type IdempotentResponse,
  type User,
} from './schema';

/**
 * Acesso a dados de contas da API (ADR 0004): usuários, refresh tokens, chaves de API e
 * Idempotency-Key. Toda decisão de corrida fica no banco (ON CONFLICT, UPDATE condicional, FOR
 * UPDATE), nunca num SELECT seguido de escrita.
 */

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Cria o usuário; `null` se o e-mail (sem diferenciar maiúsculas) já existe. */
export async function createUser(
  db: Executor,
  email: string,
  passwordHash: string,
): Promise<User | null> {
  const [user] = await db
    .insert(users)
    .values({ email: normalizeEmail(email), passwordHash })
    .onConflictDoNothing()
    .returning();
  return user ?? null;
}

export async function findUserByEmail(db: Executor, email: string): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`)
    .limit(1);
  return user ?? null;
}

export async function findUserById(db: Executor, id: number): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

// ------------------------------------------------------------------ refresh tokens

export interface NewRefreshToken {
  userId: number;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
}

export async function insertRefreshToken(db: Executor, t: NewRefreshToken): Promise<number> {
  const [row] = await db.insert(refreshTokens).values(t).returning({ id: refreshTokens.id });
  return row!.id;
}

export type RotateResult =
  | { kind: 'rotated'; userId: number; familyId: string }
  /** Token já revogado usado de novo: a família inteira foi revogada agora. */
  | { kind: 'reused'; userId: number; familyId: string }
  | { kind: 'expired' }
  | { kind: 'invalid' };

/**
 * Rotação com detecção de reuso. `FOR UPDATE` serializa dois refresh simultâneos com o mesmo
 * token: o segundo espera, encontra o token já revogado e é tratado como reuso.
 */
export async function rotateRefreshToken(
  db: Executor,
  tokenHash: string,
  next: { tokenHash: string; expiresAt: Date },
): Promise<RotateResult> {
  return db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .for('update')
      .limit(1);
    if (!cur) return { kind: 'invalid' };
    if (cur.revokedAt !== null) {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(refreshTokens.familyId, cur.familyId), isNull(refreshTokens.revokedAt)));
      return { kind: 'reused', userId: cur.userId, familyId: cur.familyId };
    }
    if (cur.expiresAt.getTime() <= Date.now()) {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(eq(refreshTokens.id, cur.id));
      return { kind: 'expired' };
    }
    const [created] = await tx
      .insert(refreshTokens)
      .values({
        userId: cur.userId,
        familyId: cur.familyId,
        tokenHash: next.tokenHash,
        expiresAt: next.expiresAt,
      })
      .returning({ id: refreshTokens.id });
    await tx
      .update(refreshTokens)
      .set({ revokedAt: sql`now()`, replacedBy: created!.id })
      .where(eq(refreshTokens.id, cur.id));
    return { kind: 'rotated', userId: cur.userId, familyId: cur.familyId };
  });
}

/** Logout: revoga a família do token apresentado (todas as sessões derivadas daquele login). */
export async function revokeRefreshFamily(db: Executor, tokenHash: string): Promise<boolean> {
  const rows = await db.execute<{ n: number }>(sql`
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = ${tokenHash})
      AND revoked_at IS NULL
    RETURNING 1 AS n`);
  return rows.length > 0;
}

// ------------------------------------------------------------------ chaves de API

export interface NewApiKey {
  userId: number;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: ApiScope[];
}

export async function insertApiKey(db: Executor, k: NewApiKey): Promise<ApiKey | null> {
  const [row] = await db.insert(apiKeys).values(k).onConflictDoNothing().returning();
  return row ?? null;
}

/** Busca pelo prefixo (índice único), inclusive revogada: quem chama decide. */
export async function findApiKeyByPrefix(db: Executor, prefix: string): Promise<ApiKey | null> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).limit(1);
  return row ?? null;
}

export async function listApiKeys(db: Executor, userId: number): Promise<ApiKey[]> {
  return db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
}

/** Revoga a chave do próprio usuário; `false` se não existe, é de outro ou já estava revogada. */
export async function revokeApiKey(db: Executor, userId: number, id: number): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

export async function touchApiKey(db: Executor, id: number): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(apiKeys.id, id));
}

// ------------------------------------------------------------------ Idempotency-Key

export const IDEMPOTENCY_TTL_HOURS = 24;

export type ReserveResult =
  | { kind: 'reserved' }
  | { kind: 'processing' }
  | { kind: 'mismatch' }
  | { kind: 'done'; response: IdempotentResponse };

/**
 * Reserva `(user_id, key)` com `INSERT … ON CONFLICT DO NOTHING` (ADR 0004): de N requisições
 * simultâneas com a mesma chave, só uma recebe `reserved`. Uma reserva com mais de 24 h é apagada e
 * a chave volta a valer como nova.
 */
export async function reserveIdempotencyKey(
  db: Executor,
  userId: number,
  key: string,
  requestHash: string,
): Promise<ReserveResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ userId, key, requestHash, status: 'processing' })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length > 0) return { kind: 'reserved' };

    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (!row) continue; // liberada entre o INSERT e o SELECT
    if (row.createdAt.getTime() < Date.now() - IDEMPOTENCY_TTL_HOURS * 3600_000) {
      await db
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.userId, userId),
            eq(idempotencyKeys.key, key),
            lt(idempotencyKeys.createdAt, sql`now() - interval '24 hours'`),
          ),
        );
      continue;
    }
    if (row.requestHash !== requestHash) return { kind: 'mismatch' };
    if (row.status === 'processing' || !row.response) return { kind: 'processing' };
    return { kind: 'done', response: row.response };
  }
  return { kind: 'processing' };
}

export async function completeIdempotencyKey(
  db: Executor,
  userId: number,
  key: string,
  response: IdempotentResponse,
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ status: 'done', response })
    .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
}

/** Solta a reserva (erro ou resposta que não vale gravar): o cliente pode tentar de novo. */
export async function releaseIdempotencyKey(
  db: Executor,
  userId: number,
  key: string,
): Promise<void> {
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.key, key),
        eq(idempotencyKeys.status, 'processing'),
      ),
    );
}
