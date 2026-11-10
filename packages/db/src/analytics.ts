import { bigint, date, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Tabelas do pipeline de cliques (migração 0002, SQL manual), declaradas aqui só para leitura pela
 * API e pelo dashboard. Ficam fora de `schema.ts` de propósito: o drizzle-kit não sabe criar tabela
 * particionada e não deve tentar gerá-las. A escrita é do worker, em SQL explícito.
 */
export const clicksHourly = pgTable(
  'clicks_hourly',
  {
    linkId: bigint('link_id', { mode: 'number' }).notNull(),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    total: bigint('total', { mode: 'number' }).notNull(),
    humans: bigint('humans', { mode: 'number' }).notNull(),
    bots: bigint('bots', { mode: 'number' }).notNull(),
    previews: bigint('previews', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.linkId, t.hour] })],
);

export const clicksDaily = pgTable(
  'clicks_daily',
  {
    linkId: bigint('link_id', { mode: 'number' }).notNull(),
    day: date('day').notNull(),
    total: bigint('total', { mode: 'number' }).notNull(),
    humans: bigint('humans', { mode: 'number' }).notNull(),
    uniques: bigint('uniques', { mode: 'number' }).notNull(),
    bots: bigint('bots', { mode: 'number' }).notNull(),
    previews: bigint('previews', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.linkId, t.day] })],
);

export const CLICK_DIMENSIONS = ['country', 'city', 'referrer', 'browser', 'os', 'device'] as const;
export type ClickDimension = (typeof CLICK_DIMENSIONS)[number];

export const clicksDailyDim = pgTable(
  'clicks_daily_dim',
  {
    linkId: bigint('link_id', { mode: 'number' }).notNull(),
    dim: text('dim').$type<ClickDimension>().notNull(),
    day: date('day').notNull(),
    value: text('value').notNull(),
    n: bigint('n', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.linkId, t.dim, t.day, t.value] })],
);

export const clicksDailyPreview = pgTable(
  'clicks_daily_preview',
  {
    linkId: bigint('link_id', { mode: 'number' }).notNull(),
    day: date('day').notNull(),
    app: text('app').notNull(),
    n: bigint('n', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.linkId, t.day, t.app] })],
);
