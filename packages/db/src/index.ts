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
export * from './accounts';
export * from './link-queries';
export * from './stats';
export * as schema from './schema';
export * from './analytics';
export {
  API_SCOPES,
  apiKeys,
  idempotencyKeys,
  links,
  refreshTokens,
  users,
  type ApiKey,
  type ApiScope,
  type IdempotentResponse,
  type Link,
  type LinkRules,
  type LinkStatus,
  type NewLink,
  type RedirectType,
  type RefreshToken,
  type User,
} from './schema';

/** Operadores do Drizzle reexportados, para os apps usarem a mesma instância do pacote. */
export { and, eq, sql } from 'drizzle-orm';
