// ========== Registry & Facade ==========
export { ConnectorRegistry } from './registry/ConnectorRegistry.js';
export { ConnectorFacade, DeadlineExpiredError, isDeadlineExpired } from './registry/ConnectorFacade.js';
export type { ConnectorFacadeOptions } from './registry/ConnectorFacade.js';
export { ConnectorManager } from './registry/ConnectorManager.js';
export type { ConnectorInstance, InstanceDefinition } from './registry/ConnectorRegistry.js';
export type { Lease, ConnectorManagerOptions } from './registry/ConnectorManager.js';

// ========== Infrastructure ==========
export { CircuitBreaker } from './infra/CircuitBreaker.js';
export { makeCache, type Cache } from './infra/Cache.js';
export { RateLimiter } from './infra/RateLimiter.js';
export { makePool, PoolAcquireTimeoutError, type Pooled } from './infra/Pool.js';
export {
  noopMetrics,
  prefixed,
  RecordingMetricsSink,
  startEventLoopLagMonitor,
  METRICS,
} from './infra/Metrics.js';
export type { MetricsSink, MetricLabels, EventLoopLagMonitor } from './infra/Metrics.js';

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

// ========== Async operation store ==========
// Moved to the provisioning service at CP-5. The operation table, dispatcher,
// and admission gate are claim-loop concerns; this package executes one
// operation at a time and knows nothing about a queue.

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
  ReadCacheInput,
  RuntimeConfigInput,
  ResolvedRuntimeConfig,
} from './config/runtime.js';

// ========== Testing ==========
// Test doubles ship under the `/testing` subpath, not from here, so nothing a
// production consumer imports can reach vitest.