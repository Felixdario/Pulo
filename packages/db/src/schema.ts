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
  smallint,
  text,
  timestamp,
  uniqueIndex,
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

export type LinkRules = Record<string, unknown>;

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
    check('links_redirect_type_check', sql`${t.redirectType} IN (301, 302, 307, 308)`),
    check('links_status_check', sql`${t.status} IN ('active', 'disabled', 'blocked_loop')`),
    check('links_max_clicks_check', sql`${t.maxClicks} > 0`),
    check('links_cache_ttl_check', sql`${t.cacheTtl} >= 0`),
  ],
);

export type Link = typeof links.$inferSelect;
export type NewLink = typeof links.$inferInsert;
export type User = typeof users.$inferSelect;
