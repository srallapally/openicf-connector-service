# OpenICF Connector Service - Split Architecture Design

## Executive Summary

This document outlines the architectural design for splitting the `openicf-connector-service` monolith into two independent packages:

1. **`@openicf/connector-core`** - A reusable core library that provides connector management, operations, and infrastructure components that can be invoked locally
2. **`@openicf/connector-websocket`** - A WebSocket server that uses the core library to provide remote connector invocation capabilities

## Goals

- **Modularity**: Separate transport-independent connector logic from transport-specific implementations
- **Reusability**: Enable the core library to be used in different contexts (HTTP, WebSocket, CLI, etc.)
- **Maintainability**: Clear separation of concerns with well-defined boundaries
- **Backward Compatibility**: Maintain existing functionality while enabling new use cases
- **Local Invocation**: Enable direct local usage of connectors without network overhead
- **Remote Invocation**: Support WebSocket-based remote connector operations

## Architecture Before the Split (historical)

> This section records the pre-split layout for context. The split described
> below has since been carried out, and the root-level `src/` and `test/` trees
> no longer exist.

```
openicf-connector-service/
├── src/
│   ├── core/              # Core connector infrastructure
│   ├── spi/               # Service Provider Interface
│   ├── filter/            # Filter parsing
│   ├── loader/            # External connector loading
│   └── server/            # HTTP & WebSocket server implementations
├── test/
├── package.json
└── tsconfig.json
```

**Entry points at that time:**
- HTTP Server: `src/server/index.ts` (Express-based REST API)
- WebSocket Client: `src/server/websocket.ts` (OAuth client connecting to control plane)

## Proposed Architecture

### Package Structure

```
packages/
├── core/                           # @openicf/connector-core
│   ├── src/
│   │   ├── registry/
│   │   │   ├── ConnectorRegistry.ts
│   │   │   ├── ConnectorFacade.ts
│   │   │   └── index.ts
│   │   ├── infra/
│   │   │   ├── CircuitBreaker.ts
│   │   │   ├── Cache.ts
│   │   │   ├── RateLimiter.ts
│   │   │   ├── Pool.ts
│   │   │   └── index.ts
│   │   ├── spi/
│   │   │   ├── types.ts
│   │   │   ├── icf-compat.ts
│   │   │   ├── configuration.ts
│   │   │   ├── schema.ts
│   │   │   └── index.ts
│   │   ├── filter/
│   │   │   ├── ast.ts
│   │   │   ├── validate.ts
│   │   │   └── sql.ts
│   │   ├── loader/
│   │   │   ├── ExternalLoader.ts
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   └── index.ts               # Public API exports
│   ├── test/
│   ├── package.json
│   └── tsconfig.json
│
├── websocket/                      # @openicf/connector-websocket
│   ├── src/
│   │   ├── server/
│   │   │   ├── RemoteConnectorService.ts
│   │   │   └── OAuthTokenProvider.ts
│   │   ├── security/
│   │   │   ├── auth.ts            # JWT validation
│   │   │   ├── csrf.ts            # CSRF protection
│   │   │   └── hardening.ts       # Security utilities
│   │   └── index.ts
│   ├── test/
│   ├── package.json
│   └── tsconfig.json
│
└── http/                           # @openicf/connector-http (optional future)
    └── [HTTP REST API implementation]
```

## Package 1: @openicf/connector-core

### Purpose
Provides the core connector framework, operation execution, and infrastructure components. Can be embedded in any application for local connector invocation.

### Public API Surface

```typescript
// Core Registry & Facade
export { ConnectorRegistry } from './registry/ConnectorRegistry.js';
export { ConnectorFacade } from './registry/ConnectorFacade.js';
export type { ConnectorInstance } from './registry/ConnectorRegistry.js';

// SPI - Service Provider Interface
export type {
  // Core types
  ConnectorSpi,
  ConnectorConfig,
  ConnectorObject,
  Uid,
  ObjectClassInfo,
  Schema,
  AttributeValue,
  OperationOptions,

  // Operation interfaces
  CreateOp,
  UpdateOp,
  DeleteOp,
  GetOp,
  SearchOp,
  SchemaOp,
  TestOp,
  SyncOp,
  ScriptOnConnectorOp,
  UpdateAttributeValuesOp,

  // Filter types
  Filter,
  AttributeFilter,
} from './spi/types.js';

export type { Configuration } from './spi/configuration.js';
export { requireNonEmpty } from './spi/configuration.js';

// Schema types (no builder utilities — construct Schema objects directly)
export type {
  AttrType,
  AttributeInfo,
  ObjectClassInfo,
  Schema,
} from './spi/schema.js';

// Infrastructure Components
export { CircuitBreaker } from './infra/CircuitBreaker.js';
export { makeCache, type Cache } from './infra/Cache.js';
export { RateLimiter } from './infra/RateLimiter.js';
export { makePool, type Pooled } from './infra/Pool.js';

// External Connector Loading
export { loadExternalConnectors } from './loader/ExternalLoader.js';
export type { Manifest, InstanceDef, Instances, ConnectorKey } from './loader/types.js';
export { toConnectorKey, parseConnectorKey } from './loader/types.js';

// Filter Utilities
export { parseFilter } from './filter/validate.js';
export { toSql, type ColumnMap } from './filter/sql.js';
export type * from './filter/ast.js';
```

### Dependencies

```json
{
  "dependencies": {
    "lru-cache": "^11.0.1",
    "tarn": "^3.0.2"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "typescript": "^5.6.2",
    "vitest": "^3.2.4"
  }
}
```

### Usage Example - Local Invocation

```typescript
import {
  ConnectorRegistry,
  ConnectorFacade,
  loadExternalConnectors
} from '@openicf/connector-core';

// Create registry
const registry = new ConnectorRegistry();

// Option 1: Register inline connector (type, version, factory)
registry.registerFactory('my-connector', '1.0.0', async (config) => {
  return {
    async test() { /* ... */ },
    async schema() { /* ... */ },
    async create(objectClass, attributes, options) { /* ... */ },
    async get(objectClass, uid, options) { /* ... */ },
    // ... other operations
  };
});

// initInstance signature: (id, type, version, config)
await registry.initInstance('conn1', 'my-connector', '1.0.0', {
  host: 'ldap.example.com',
  port: 389,
  // ... config
});

// Option 2: Load external connectors from directory
await loadExternalConnectors('./connectors', registry);

// Get connector and perform operations
const connector = registry.get('conn1');
const facade = new ConnectorFacade(connector.impl);

// Direct operations with built-in caching and circuit breaking
const schema = await facade.schema();
await facade.test();
const uid = await facade.create('account', {
  username: 'jdoe',
  email: 'jdoe@example.com'
});
const account = await facade.get('account', uid);
const results = await facade.search('account', null, { pageSize: 100 });
```

### Key Features

- **Transport-agnostic**: No HTTP, WebSocket, or other transport dependencies
- **Zero network overhead**: Direct in-process invocation
- **Production-ready infrastructure**:
  - Circuit breaker for fault tolerance
  - LRU cache with TTL
  - Token bucket rate limiter
  - Resource pooling
- **External connector loading**: Dynamic loading from manifest.json
- **Type-safe**: Full TypeScript support
- **Testable**: Easy to unit test without network dependencies

## Package 2: @openicf/connector-websocket

### Purpose
WebSocket server that connects to a remote control plane, receives connector operation requests, and executes them using the core library.

### Public API Surface

```typescript
// CLI entry point (only public export from the package entry)
export { main } from './index.js';

// Internal modules — not re-exported from the package root; import directly if needed:
// import { RemoteConnectorService } from '@openicf/connector-websocket/dist/server/RemoteConnectorService.js'
// import { OAuthTokenProvider } from '@openicf/connector-websocket/dist/server/OAuthTokenProvider.js'
// import { requireJwt } from '@openicf/connector-websocket/dist/security/auth.js'
```

### Dependencies

```json
{
  "dependencies": {
    "@openicf/connector-core": "workspace:*",
    "ws": "^8.18.0",
    "jose": "^5.3.0",
    "cookie-parser": "^1.4.7",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/ws": "^8.5.12",
    "@types/cookie-parser": "^1.4.10",
    "@types/node": "^22.5.0",
    "typescript": "^5.6.2",
    "vitest": "^3.2.4"
  }
}
```

### Usage Example - Remote Invocation

```typescript
import {
  RemoteConnectorService,
  OAuthTokenProvider
} from '@openicf/connector-websocket';
import {
  ConnectorRegistry,
  loadExternalConnectors
} from '@openicf/connector-core';

// Setup registry with connectors
const registry = new ConnectorRegistry();
await loadExternalConnectors('./connectors', registry);

// Configure OAuth for control plane authentication
const oauth = new OAuthTokenProvider({
  tokenUrl: 'https://auth.example.com/oauth/token',
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  scope: 'connector:read connector:write',
  audience: 'https://api.example.com',
});

// Start WebSocket service
const service = new RemoteConnectorService({
  serverUrl: 'wss://control-plane.example.com/ws',
  registry,
  oauth,
  reconnectInitialDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
});

await service.start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await service.shutdown();
  process.exit(0);
});
```

### CLI Usage

```bash
# Using environment variables
export REMOTE_CONNECTOR_WS_URL=wss://control-plane.example.com/ws
export OAUTH_TOKEN_URL=https://auth.example.com/oauth/token
export OAUTH_CLIENT_ID=my-client
export OAUTH_CLIENT_SECRET=secret
export CONNECTORS_DIR=/path/to/connectors

node dist/index.js

# Or with CLI flags
node dist/index.js --connectors /path/to/connectors
```

### Message Protocol

#### Client → Server (Control Plane)

```typescript
// Ping
{ type: "ping", requestId: "req-1" }

// List available connectors
{ type: "list-connectors", requestId: "req-2" }

// Execute operation
{
  type: "operation",
  requestId: "req-3",
  connectorId: "ldap-connector",
  operation: "search",
  payload: {
    objectClass: "account",
    filter: null,
    options: { pageSize: 100 }
  }
}
```

#### Server → Client (Connector Service)

```typescript
// Service info (sent on connect)
{
  type: "service-info",
  service: "openicf-connector-service",
  startedAt: "2025-01-15T10:00:00Z",
  connectors: ["ldap-connector", "db-connector"]
}

// Pong response
{
  type: "pong",
  requestId: "req-1",
  timestamp: "2025-01-15T10:00:01Z",
  connectors: ["ldap-connector", "db-connector"]
}

// Connector list response
{
  type: "connectors",
  requestId: "req-2",
  connectors: ["ldap-connector", "db-connector"]
}

// Operation response (success)
{
  type: "response",
  requestId: "req-3",
  success: true,
  result: [
    { uid: "uid1", objectClass: "account", attributes: {...} },
    { uid: "uid2", objectClass: "account", attributes: {...} }
  ]
}

// Operation response (error)
{
  type: "response",
  requestId: "req-3",
  success: false,
  error: {
    message: "Connection timeout",
    name: "ConnectorError"
  }
}

// Rate limit error
{
  type: "error",
  requestId: "req-4",
  error: "Rate limit exceeded. Please slow down your requests.",
  code: "RATE_LIMIT_EXCEEDED"
}
```

### Security Features

1. **OAuth 2.0 Authentication**
   - Client credentials flow
   - Automatic token refresh (30s early expiry buffer)
   - Token invalidation on 401/403

2. **Token Expiry Validation**
   - Periodic checks every 30s
   - Proactive reconnection 5 min before expiry
   - Automatic disconnection on expiry

3. **Rate Limiting**
   - Token bucket: 5 tokens/sec sustained, 20-token burst
   - Different costs for message types:
     - `ping`, `list-connectors`: 0.5 tokens
     - `operation`: 1 token
   - Graceful error responses (no disconnection)

4. **CSRF Protection**
   - WebSocket origin validation
   - Rejects unauthorized cross-origin connections

5. **Connection Management**
   - Automatic reconnection with exponential backoff
   - Graceful shutdown
   - Connection health monitoring

## Migration Path

### Phase 1: Package Setup (Week 1)

1. Create monorepo structure using npm/yarn/pnpm workspaces
2. Move code to respective packages:
   - Core: `src/core/`, `src/spi/`, `src/filter/`, `src/loader/` → `packages/core/`
   - WebSocket: `src/server/websocket.ts`, `src/server/auth.ts`, `src/server/csrf.ts` → `packages/websocket/`
3. Update import paths
4. Configure TypeScript project references
5. Set up build scripts

### Phase 2: API Refinement (Week 1-2)

1. Define public API exports in each package
2. Add barrel exports (`index.ts`)
3. Configure package.json exports field
4. Add API documentation
5. Create usage examples

### Phase 3: Testing (Week 2)

1. Move and update tests
2. Test core library independently
3. Test WebSocket server with core library
4. Integration tests
5. Add CI/CD pipeline

### Phase 4: Documentation & Publishing (Week 3)

1. README for each package
2. API documentation
3. Migration guide
4. Publish to npm (if desired) or internal registry
5. Update main repository README

### Phase 5: Deprecation (Week 4+)

1. Mark old structure as deprecated
2. Provide migration timeline
3. Update all consumers
4. Remove old code

## Workspace Configuration

### Root package.json

```json
{
  "name": "openicf-connector-workspace",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "engines": {
    "node": ">=20.12.0"
  },
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "clean": "npm run clean --workspaces --if-present"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "typescript": "^5.6.2",
    "vitest": "^3.2.4",
    "eslint": "^9.10.0",
    "tsx": "^4.16.2"
  }
}
```

### packages/core/package.json

```json
{
  "name": "@openicf/connector-core",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./registry": {
      "import": "./dist/registry/index.js",
      "types": "./dist/registry/index.d.ts"
    },
    "./infra": {
      "import": "./dist/infra/index.js",
      "types": "./dist/infra/index.d.ts"
    },
    "./spi": {
      "import": "./dist/spi/index.js",
      "types": "./dist/spi/index.d.ts"
    },
    "./filter": {
      "import": "./dist/filter/index.js",
      "types": "./dist/filter/index.d.ts"
    },
    "./loader": {
      "import": "./dist/loader/index.js",
      "types": "./dist/loader/index.d.ts"
    }
  },
  "engines": {
    "node": ">=20.12.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "lru-cache": "^11.0.1",
    "tarn": "^3.0.2"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "typescript": "^5.6.2",
    "vitest": "^3.2.4"
  }
}
```

### packages/websocket/package.json

```json
{
  "name": "@openicf/connector-websocket",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "openicf-websocket": "./dist/index.js"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "engines": {
    "node": ">=20.12.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@openicf/connector-core": "file:../core",
    "cookie-parser": "^1.4.7",
    "cors": "^2.8.5",
    "express-rate-limit": "^8.2.1",
    "helmet": "^8.1.0",
    "jose": "^5.3.0",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/cookie-parser": "^1.4.10",
    "@types/cors": "^2.8.19",
    "@types/express-rate-limit": "^5.1.3",
    "@types/node": "^22.5.0",
    "@types/supertest": "^2.0.16",
    "@types/ws": "^8.5.12",
    "supertest": "^7.0.0",
    "tsx": "^4.16.2",
    "typescript": "^5.6.2",
    "vitest": "^3.2.4"
  }
}
```

## Build Configuration

### packages/core/tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/*.test.ts"]
}
```

### packages/websocket/tsconfig.json

```json
{
  "extends": "../core/tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "references": [
    { "path": "../core" }
  ],
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/*.test.ts"]
}
```

## Benefits of This Architecture

### For Core Library Users

✅ **Direct Local Invocation**: No network overhead, no server required
✅ **Embeddable**: Can be integrated into any Node.js application
✅ **Minimal Dependencies**: Only essential libraries (lru-cache, tarn)
✅ **Type-Safe**: Full TypeScript support with exported types
✅ **Production-Ready**: Circuit breaker, caching, rate limiting built-in
✅ **Testable**: Easy to unit test without mocking network calls

### For WebSocket Server Users

✅ **Remote Invocation**: Centralized connector service for multiple clients
✅ **Secure**: OAuth 2.0, JWT, CSRF protection, rate limiting
✅ **Resilient**: Auto-reconnect, token refresh, connection monitoring
✅ **Scalable**: Can run multiple instances with load balancing
✅ **Observable**: Comprehensive logging and monitoring hooks

### For Maintainers

✅ **Clear Boundaries**: Transport logic separate from business logic
✅ **Independent Versioning**: Core and WebSocket can evolve independently
✅ **Easier Testing**: Each package can be tested in isolation
✅ **Better Code Organization**: Single Responsibility Principle
✅ **Future-Proof**: Easy to add new transports (HTTP, gRPC, etc.)

## Future Enhancements

### Package 3: @openicf/connector-http (Optional)

A separate HTTP REST API server using the core library:

```typescript
import { ConnectorRegistry } from '@openicf/connector-core';
import { createHttpServer } from '@openicf/connector-http';

const registry = new ConnectorRegistry();
// ... configure connectors ...

const server = createHttpServer({
  registry,
  port: 8080,
  auth: {
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    expectedIssuer: 'https://auth.example.com',
    expectedAudience: 'connector-api',
  },
  cors: {
    origin: 'https://app.example.com',
  },
  rateLimit: {
    windowMs: 60_000,
    max: 300,
  },
});

await server.start();
```

### Package 4: @openicf/connector-cli (Optional)

Command-line interface for testing connectors:

```bash
# Test connector
openicf test my-connector --config config.json

# Run search
openicf search my-connector account --filter "username eq 'jdoe'"

# Get schema
openicf schema my-connector
```

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking changes for existing users | High | Maintain backward compatibility in v1, provide migration guide |
| Increased complexity | Medium | Clear documentation, examples, and migration path |
| Dependency management | Low | Use workspace protocol, lock file |
| Build time increase | Low | Optimize TypeScript project references, use incremental builds |
| Version skew between packages | Medium | Use workspace protocol, coordinated releases |

## Success Criteria

1. ✅ Core library can be used independently without server dependencies
2. ✅ WebSocket server successfully uses core library
3. ✅ All existing tests pass
4. ✅ New packages have >90% test coverage
5. ✅ Documentation is complete and clear
6. ✅ Migration guide is provided
7. ✅ No performance regression
8. ✅ Build and CI/CD pipelines work

## Timeline

- **Week 1**: Package setup, code migration, build configuration
- **Week 2**: API refinement, testing, integration tests
- **Week 3**: Documentation, examples, migration guide
- **Week 4+**: Publishing, deprecation, consumer migration

## Conclusion

This split architecture provides a clean separation between the reusable connector core logic and the transport-specific WebSocket server implementation. It enables:

1. **Local usage** for applications that need direct connector access
2. **Remote usage** for distributed systems requiring centralized connector management
3. **Future extensibility** for adding new transports (HTTP, gRPC, etc.)
4. **Better maintainability** through clear module boundaries

The migration path is straightforward, leveraging npm/yarn/pnpm workspaces and TypeScript project references for a smooth transition.
