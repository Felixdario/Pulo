/** Versão do pacote compartilhado; usada pelos apps para provar o link entre pacotes. */
export const SHARED_VERSION = '0.0.0';

export {
  BASE62,
  createSlugGenerator,
  DEFAULT_LENGTH_FOR_ATTEMPT,
  generateSlug,
  type RandomBytes,
  type SlugGenerator,
  type SlugGeneratorOptions,
} from './slug';
export {
  ALIAS_REGEX,
  isReservedSlug,
  RESERVED_SLUGS,
  validateAlias,
  type AliasValidation,
} from './reserved';
export { classifyIp, isPublicIp, parseIpv4, parseIpv6, type IpKind } from './ip';
export {
  MAX_DESTINATION_LENGTH,
  normalizeShortDomains,
  validateDestination,
  type DestinationErrorCode,
  type DestinationOptions,
  type DestinationValidation,
} from './destination';
