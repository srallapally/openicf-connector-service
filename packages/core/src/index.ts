// ========== Registry & Facade ==========
export { ConnectorRegistry } from './registry/ConnectorRegistry.js';
export { ConnectorFacade } from './registry/ConnectorFacade.js';
export type { ConnectorInstance } from './registry/ConnectorRegistry.js';

// ========== Infrastructure ==========
export { CircuitBreaker } from './infra/CircuitBreaker.js';
export { makeCache, type Cache } from './infra/Cache.js';
export { RateLimiter } from './infra/RateLimiter.js';
export { makePool, type Pooled } from './infra/Pool.js';

// ========== SPI - Types & Interfaces ==========
export type * from './spi/types.js';
export type * from './spi/icf-compat.js';
export { ConnectorError, isConnectorError } from './spi/errors.js';
export type { ConnectorErrorCode } from './spi/errors.js';
export type { Configuration } from './spi/configuration.js';
export { requireNonEmpty } from './spi/configuration.js';

// ========== Filter Utilities ==========
export { parseFilter } from './filter/validate.js';
export { toSql, type ColumnMap } from './filter/sql.js';
export type * from './filter/ast.js';

// ========== Loader ==========
export { loadExternalConnectors } from './loader/ExternalLoader.js';
export type { Manifest, InstanceDef, Instances, ConnectorKey, ConnectorCapabilities } from './loader/types.js';
export { toConnectorKey, parseConnectorKey, resolveCapabilities } from './loader/types.js';

// ========== Runtime configuration ==========
export {
  resolveRuntimeConfig,
  isMutationOp,
  OP_KINDS,
  MUTATION_OP_KINDS,
  READ_OP_KINDS,
  RUNTIME_DEFAULTS,
  ATTEMPT_DEADLINE_MIN_MS,
  ATTEMPT_DEADLINE_MAX_MS,
} from './config/runtime.js';
export type {
  OpKind,
  MutationOpKind,
  ReadOpKind,
  PerOp,
  RateLimitInput,
  ReadCacheInput,
  RuntimeConfigInput,
  ResolvedRateLimit,
  ResolvedRuntimeConfig,
} from './config/runtime.js';