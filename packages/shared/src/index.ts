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
export {
  classifyIp,
  compileCidrs,
  isPublicIp,
  parseIpv4,
  parseIpv6,
  truncateIp,
  type IpKind,
} from './ip';
export { classifyAgent, previewApp, type AgentKind } from './agent';
export { DIRECT_REFERRER, IP_REFERRER, referrerDomain, UNKNOWN_REFERRER } from './referrer';
export { normalizeCountry } from './country';
export { detectDevice, type DeviceInfo, type DeviceOs, type DeviceType } from './device';
export {
  hasDeviceRules,
  hasGeoRules,
  linkRulesSchema,
  resolveDestination,
  type LinkRules,
  type ResolveContext,
} from './rules';
export { mergeQuery } from './query';
export { uuidv7, uuidv7Timestamp } from './uuid';
export {
  MAX_DESTINATION_LENGTH,
  normalizeShortDomains,
  validateDestination,
  type DestinationErrorCode,
  type DestinationOptions,
  type DestinationValidation,
} from './destination';
