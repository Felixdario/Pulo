export { createDb, type CreateDbOptions, type Database } from './client';
export {
  createLink,
  createLinks,
  findLinkBySlug,
  getClickCount,
  DEFAULT_MAX_ATTEMPTS,
  InvalidAliasError,
  SlugExhaustedError,
  SlugTakenError,
  type CreateLinkErrorCode,
  type CreateLinkInput,
  type CreateLinkOptions,
  type CreateLinkResult,
  type Executor,
} from './links';
export * as schema from './schema';
export * from './analytics';
export { links, users, type Link, type NewLink, type RedirectType, type User } from './schema';

/** Operadores do Drizzle reexportados, para os apps usarem a mesma instância do pacote. */
export { and, eq, sql } from 'drizzle-orm';
