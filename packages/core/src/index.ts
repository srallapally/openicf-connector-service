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
export type { Configuration } from './spi/configuration.js';
export { requireNonEmpty } from './spi/configuration.js';

// ========== Filter Utilities ==========
export { parseFilter } from './filter/validate.js';
export { toSql, type ColumnMap } from './filter/sql.js';
export type * from './filter/ast.js';

// ========== Loader ==========
export { loadExternalConnectors } from './loader/ExternalLoader.js';
export type { Manifest, InstanceDef, Instances, ConnectorKey } from './loader/types.js';
export { toConnectorKey, parseConnectorKey } from './loader/types.js';