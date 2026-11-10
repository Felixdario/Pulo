import type { LinkRules } from '@encurtador/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** `text COLLATE "C"`: comparação byte a byte, logo diferencia maiúsculas (ADR 0001). */
const textC = customType<{ data: string }>({
  dataType: () => 'text COLLATE "C"',
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

export const REDIRECT_TYPES = [301, 302, 307, 308] as const;
export type RedirectType = (typeof REDIRECT_TYPES)[number];
export const LINK_STATUSES = ['active', 'disabled', 'blocked_loop'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export type { LinkRules } from '@encurtador/shared';

export const links = pgTable(
  'links',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    // Sem ON DELETE SET NULL: link órfão ficaria indistinguível de link anônimo.
    userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
    slug: textC('slug').notNull(),
    isCustom: boolean('is_custom').notNull().default(false),
    destination: text('destination').notNull(),
    title: text('title'),
    redirectType: smallint('redirect_type').$type<RedirectType>().notNull().default(302),
    cacheTtl: integer('cache_ttl').notNull().default(3600),
    status: text('status').$type<LinkStatus>().notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    maxClicks: integer('max_clicks'),
    passwordHash: text('password_hash'),
    forwardQuery: boolean('forward_query').notNull().default(true),
    /** Cliques humanos processados pelo worker (mesma instrução dos agregados). */
    clickCount: bigint('click_count', { mode: 'number' }).notNull().default(0),
    rules: jsonb('rules').$type<LinkRules>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Vale também para links apagados: um slug nunca é reaproveitado.
    uniqueIndex('links_slug_key').on(t.slug),
    index('links_user_created_idx')
      .on(t.userId, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    // Ordenações de `GET /v1/links` (ADR 0004): mesma expressão do ORDER BY e do cursor.
    index('links_user_clicks_idx')
      .on(t.userId, t.clickCount.desc(), t.id.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    index('links_user_title_idx')
      .on(t.userId, sql`coalesce(${t.title}, '')`, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    check('links_redirect_type_check', sql`${t.redirectType} IN (301, 302, 307, 308)`),
    check('links_status_check', sql`${t.status} IN ('active', 'disabled', 'blocked_loop')`),
    check('links_max_clicks_check', sql`${t.maxClicks} > 0`),
    check('links_cache_ttl_check', sql`${t.cacheTtl} >= 0`),
  ],
);

/**
 * Refresh tokens opacos (ADR 0004, decisão 1). Só o SHA-256 fica no banco. A rotação revoga o token
 * usado e aponta `replaced_by` para o novo, da mesma família; um token já revogado usado de novo
 * revoga a família inteira.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    replacedBy: bigint('replaced_by', { mode: 'number' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_key').on(t.tokenHash),
    index('refresh_tokens_family_idx').on(t.familyId),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
);

export const API_SCOPES = ['links:read', 'links:write', 'stats:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Chaves de API `enc_<prefixo>_<segredo>` (ADR 0004, decisão 2): busca pelo prefixo, SHA-256. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: textC('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().$type<ApiScope[]>().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('api_keys_prefix_key').on(t.prefix),
    index('api_keys_user_idx').on(t.userId, t.createdAt.desc()),
    check(
      'api_keys_scopes_check',
      sql`cardinality(${t.scopes}) > 0 AND ${t.scopes} <@ ARRAY['links:read', 'links:write', 'stats:read']::text[]`,
    ),
  ],
);

export const IDEMPOTENCY_STATUSES = ['processing', 'done'] as const;

export interface IdempotentResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Respostas gravadas por `Idempotency-Key` (ADR 0004), válidas por 24 h. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: textC('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').$type<(typeof IDEMPOTENCY_STATUSES)[number]>().notNull(),
    response: jsonb('response').$type<IdempotentResponse>(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    index('idempotency_keys_created_idx').on(t.createdAt),
    check('idempotency_keys_status_check', sql`${t.status} IN ('processing', 'done')`),
  ],
);

export type Link = typeof links.$inferSelect;
export type NewLink = typeof links.$inferInsert;
export type User = typeof users.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
