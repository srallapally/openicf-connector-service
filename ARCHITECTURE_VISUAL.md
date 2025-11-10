# OpenICF Connector Service - Visual Architecture Guide

## Current Monolithic Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 openicf-connector-service                       │
│                      (Monolith)                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  src/                                                           │
│  ├── core/                    ┐                                │
│  │   ├── ConnectorRegistry    │                                │
│  │   ├── ConnectorFacade      │                                │
│  │   ├── CircuitBreaker       │ Core Logic                     │
│  │   ├── Cache                │ (Reusable)                     │
│  │   ├── RateLimiter          │                                │
│  │   └── Pool                 ┘                                │
│  │                                                              │
│  ├── spi/                     ┐                                │
│  │   ├── types                │ Interfaces                     │
│  │   ├── configuration        │ (Reusable)                     │
│  │   └── schema               ┘                                │
│  │                                                              │
│  ├── filter/                  ┐                                │
│  │   ├── ast                  │ Utilities                      │
│  │   ├── validate             │ (Reusable)                     │
│  │   └── sql                  ┘                                │
│  │                                                              │
│  ├── loader/                  ┐                                │
│  │   └── ExternalLoader       ┘ Loader (Reusable)              │
│  │                                                              │
│  └── server/                  ┐                                │
│      ├── index.ts (HTTP)      │                                │
│      ├── websocket.ts (WS)    │ Transport Layer                │
│      ├── routes.ts            │ (Transport-specific)           │
│      ├── auth.ts              │                                │
│      ├── csrf.ts              │                                │
│      └── hardening.ts         ┘                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Issues:
❌ Cannot use connectors locally without server
❌ Tight coupling between core logic and transport
❌ Difficult to add new transports
❌ All dependencies bundled together
```

## Proposed Split Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                     Workspace Root                                    │
│                 (openicf-connector-workspace)                         │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │           @openicf/connector-core                            │    │
│  │         (Core Library - Local Invocation)                    │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │                                                              │    │
│  │  ✅ ConnectorRegistry         Manages connector factories   │    │
│  │  ✅ ConnectorFacade           Wraps operations               │    │
│  │  ✅ CircuitBreaker            Fault tolerance                │    │
│  │  ✅ Cache                     LRU cache with TTL             │    │
│  │  ✅ RateLimiter               Token bucket limiter           │    │
│  │  ✅ Pool                      Resource pooling               │    │
│  │  ✅ SPI Types                 All interfaces                 │    │
│  │  ✅ Filter utilities          Parsing & SQL conversion       │    │
│  │  ✅ ExternalLoader            Dynamic connector loading      │    │
│  │                                                              │    │
│  │  Dependencies: lru-cache, tarn (minimal)                    │    │
│  │  Entry: import { ... } from '@openicf/connector-core'       │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                  ▲                                    │
│                                  │ depends on                         │
│                                  │                                    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │        @openicf/connector-websocket                          │    │
│  │      (WebSocket Server - Remote Invocation)                  │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │                                                              │    │
│  │  ✅ RemoteConnectorService    WebSocket client               │    │
│  │  ✅ OAuthTokenProvider         OAuth 2.0 handling            │    │
│  │  ✅ Message Protocol           Request/response handling     │    │
│  │  ✅ JWT Auth                   Token validation              │    │
│  │  ✅ CSRF Protection            Origin validation             │    │
│  │  ✅ Connection Management      Auto-reconnect, monitoring    │    │
│  │                                                              │    │
│  │  Dependencies: @openicf/connector-core, ws, jose            │    │
│  │  Entry: npx openicf-websocket                               │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │           @openicf/connector-http (Future)                   │    │
│  │         (HTTP REST API Server)                               │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │  ✅ Express routes, JWT auth, CORS, rate limiting            │    │
│  │  Dependencies: @openicf/connector-core, express, helmet      │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘

Benefits:
✅ Core library usable locally without server
✅ Clean separation of concerns
✅ Easy to add new transports
✅ Minimal dependencies per package
✅ Independent versioning
```

## File Migration Map

### Core Package (@openicf/connector-core)

| Source                          | Destination                                      |
|---------------------------------|--------------------------------------------------|
| `src/core/ConnectorRegistry.ts` | `packages/core/src/registry/ConnectorRegistry.ts` |
| `src/core/ConnectorFacade.ts`   | `packages/core/src/registry/ConnectorFacade.ts`   |
| `src/core/CircuitBreaker.ts`    | `packages/core/src/infrastructure/CircuitBreaker.ts` |
| `src/core/Cache.ts`             | `packages/core/src/infrastructure/Cache.ts`       |
| `src/core/RateLimiter.ts`       | `packages/core/src/infrastructure/RateLimiter.ts` |
| `src/core/Pool.ts`              | `packages/core/src/infrastructure/Pool.ts`        |
| `src/spi/types.ts`              | `packages/core/src/spi/types.ts`                  |
| `src/spi/icf-compat.ts`         | `packages/core/src/spi/icf-compat.ts`             |
| `src/spi/configuration.ts`      | `packages/core/src/spi/configuration.ts`          |
| `src/spi/schema.ts`             | `packages/core/src/spi/schema.ts`                 |
| `src/filter/ast.ts`             | `packages/core/src/filter/ast.ts`                 |
| `src/filter/validate.ts`        | `packages/core/src/filter/validate.ts`            |
| `src/filter/sql.ts`             | `packages/core/src/filter/sql.ts`                 |
| `src/loader/ExternalLoader.ts`  | `packages/core/src/loader/ExternalLoader.ts`      |

### WebSocket Package (@openicf/connector-websocket)

| Source                          | Destination                                           |
|---------------------------------|-------------------------------------------------------|
| `src/server/websocket.ts`       | Split into multiple files:                            |
|                                 | `packages/websocket/src/server/RemoteConnectorService.ts` |
|                                 | `packages/websocket/src/server/OAuthTokenProvider.ts` |
|                                 | `packages/websocket/src/index.ts` (main entry)        |
| `src/server/auth.ts`            | `packages/websocket/src/security/auth.ts`             |
| `src/server/csrf.ts`            | `packages/websocket/src/security/csrf.ts`             |
| `src/server/hardening.ts`       | `packages/websocket/src/security/hardening.ts`        |

### HTTP Package (@openicf/connector-http) - Future

| Source                   | Destination                                      |
|--------------------------|--------------------------------------------------|
| `src/server/index.ts`    | `packages/http/src/server/index.ts`              |
| `src/server/routes.ts`   | `packages/http/src/server/routes.ts`             |
| (reuse security from WS) | `packages/http/src/security/...`                 |

## Data Flow Comparison

### Before: Monolithic Local Call

```
Application Code
      ↓
  [CANNOT DO - No API for local use]
      ↓
  Must use HTTP/WebSocket
      ↓
  Network overhead
```

### After: Core Library Local Call

```
Application Code
      ↓
  import { ConnectorRegistry, ConnectorFacade } from '@openicf/connector-core'
      ↓
  registry.get('my-connector')
      ↓
  facade.search('account', null)
      ↓
  ┌─────────────────┐
  │ Circuit Breaker │ ← Fault tolerance
  └─────────────────┘
          ↓
  ┌─────────────────┐
  │  Cache Check    │ ← Performance
  └─────────────────┘
          ↓
  ┌─────────────────┐
  │ Connector SPI   │ ← Actual operation
  └─────────────────┘
          ↓
  Results (in-process, no network)
```

### WebSocket Remote Call Flow

```
Control Plane
      ↓
  WebSocket Message
      {
        type: "operation",
        connectorId: "ldap",
        operation: "search",
        payload: { objectClass: "account" }
      }
      ↓
  [TLS/WSS Connection]
      ↓
  ┌──────────────────────────────────────┐
  │  @openicf/connector-websocket        │
  │                                       │
  │  1. OAuth Token Validation            │
  │  2. Rate Limiting Check               │
  │  3. Message Parsing                   │
  │  4. CSRF Origin Validation            │
  └──────────────────────────────────────┘
      ↓
  Uses @openicf/connector-core
      ↓
  registry.get('ldap')
      ↓
  facade.search('account', null)
      ↓
  ┌─────────────────┐
  │ Circuit Breaker │
  └─────────────────┘
      ↓
  ┌─────────────────┐
  │  Cache Check    │
  └─────────────────┘
      ↓
  ┌─────────────────┐
  │ LDAP Connector  │
  └─────────────────┘
      ↓
  Results
      ↓
  WebSocket Response
      {
        type: "response",
        requestId: "...",
        success: true,
        result: [...]
      }
      ↓
  Control Plane
```

## Package Dependency Graph

```
┌─────────────────────────────────────────────────────────────┐
│                      External Dependencies                   │
├─────────────────────────────────────────────────────────────┤
│  lru-cache  tarn  ws  jose  cookie-parser  zod  express     │
└─────────────────────────────────────────────────────────────┘
           │                    │                    │
           │                    │                    │
           ▼                    ▼                    ▼
    ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
    │    Core     │    │  WebSocket   │    │    HTTP      │
    │  (lru-cache,│◄───┤ (ws, jose,   │    │  (express,   │
    │   tarn)     │    │  core)       │    │   core)      │
    └─────────────┘    └──────────────┘    └──────────────┘
         ▲                                         ▲
         │                                         │
         └─────────────────┬───────────────────────┘
                          │
                  No circular dependencies
                  Clear dependency flow
```

## Use Case Scenarios

### Scenario 1: Embedded Application (Local)

```typescript
// Application: Identity Management System
// Requirement: Direct database provisioning without network calls

import { ConnectorRegistry, ConnectorFacade } from '@openicf/connector-core';

class IdentityService {
  private registry = new ConnectorRegistry();

  async initialize() {
    // Register database connector
    this.registry.registerFactory('db', async (config) => ({
      async create(objectClass, attrs) {
        // Direct database insert
      },
      // ... other operations
    }));

    await this.registry.initInstance('hr-db', 'db', {
      host: 'localhost',
      database: 'hr',
    });
  }

  async createUser(userData: any) {
    const facade = new ConnectorFacade(
      this.registry.get('hr-db').impl
    );

    // Direct in-process call - no network overhead
    const uid = await facade.create('user', userData);
    return uid;
  }
}

// Benefits:
// ✅ No server needed
// ✅ No network latency
// ✅ Transaction support (same process)
// ✅ Simpler deployment
```

### Scenario 2: Remote Control Plane (WebSocket)

```typescript
// Application: Multi-tenant SaaS Platform
// Requirement: Centralized connector service for multiple tenants

import { RemoteConnectorService } from '@openicf/connector-websocket';
import { ConnectorRegistry } from '@openicf/connector-core';

class TenantConnectorService {
  async start() {
    const registry = new ConnectorRegistry();

    // Load tenant-specific connectors
    await loadExternalConnectors('./tenant-connectors', registry);

    const service = new RemoteConnectorService({
      serverUrl: 'wss://control-plane.example.com/tenant-123',
      registry,
      oauth: new OAuthTokenProvider({
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: process.env.OAUTH_CLIENT_ID!,
        clientSecret: process.env.OAUTH_CLIENT_SECRET!,
      }),
    });

    await service.start();
  }
}

// Benefits:
// ✅ Centralized management
// ✅ Multi-tenant isolation
// ✅ Remote updates
// ✅ OAuth security
// ✅ Rate limiting
```

### Scenario 3: Hybrid Deployment

```typescript
// Application: Enterprise Identity Hub
// Requirement: Local connectors for databases, remote for cloud apps

import { ConnectorRegistry, ConnectorFacade } from '@openicf/connector-core';
import { RemoteConnectorService } from '@openicf/connector-websocket';

class HybridConnectorService {
  private localRegistry = new ConnectorRegistry();
  private remoteService?: RemoteConnectorService;

  async initializeLocal() {
    // Local connectors for on-prem databases
    this.localRegistry.registerFactory('db', dbConnectorFactory);
    this.localRegistry.registerFactory('ldap', ldapConnectorFactory);

    await this.localRegistry.initInstance('on-prem-db', 'db', {...});
    await this.localRegistry.initInstance('corporate-ldap', 'ldap', {...});
  }

  async initializeRemote() {
    const remoteRegistry = new ConnectorRegistry();

    // Remote connectors for cloud SaaS apps
    await loadExternalConnectors('./cloud-connectors', remoteRegistry);

    this.remoteService = new RemoteConnectorService({
      serverUrl: 'wss://cloud-control.example.com',
      registry: remoteRegistry,
      oauth: {...},
    });

    await this.remoteService.start();
  }

  async provisionUser(target: string, userData: any) {
    if (target.startsWith('on-prem-')) {
      // Use local registry - direct call
      const facade = new ConnectorFacade(
        this.localRegistry.get(target).impl
      );
      return await facade.create('user', userData);
    } else {
      // Remote connectors handled by RemoteConnectorService
      // Control plane will route to appropriate service
      throw new Error('Use control plane API for cloud connectors');
    }
  }
}

// Benefits:
// ✅ Best of both worlds
// ✅ Low latency for local
// ✅ Centralized management for remote
// ✅ Flexible deployment
```

## Comparison Matrix

| Feature | Monolith | Core Package | WebSocket Package |
|---------|----------|--------------|-------------------|
| **Local Invocation** | ❌ No API | ✅ Primary use case | ❌ Remote only |
| **Remote Invocation** | ✅ HTTP/WS | ❌ Not applicable | ✅ Primary use case |
| **Network Overhead** | ✅ Required | ✅ None | ✅ Required |
| **Dependencies** | 20+ packages | 2 packages | 5+ packages |
| **Deployment** | Server required | Library embed | Server required |
| **Use in Tests** | ❌ Mock network | ✅ Direct import | ❌ Mock network |
| **Transactions** | ❌ Network boundary | ✅ Same process | ❌ Network boundary |
| **Latency** | ~10-100ms | ~0.01ms | ~10-100ms |
| **Security** | Network layer | App layer | OAuth + JWT + CSRF |
| **Fault Tolerance** | Circuit breaker | Circuit breaker | Circuit breaker + reconnect |
| **Caching** | Shared | Per-facade | Shared |
| **Versioning** | Monolithic | Independent | Independent |

## Security Architecture

### Core Package (No Network)

```
┌────────────────────────────────────┐
│  Application Security Context      │
│                                    │
│  Your application controls:        │
│  - Authentication                  │
│  - Authorization                   │
│  - Input validation                │
│  - Connector config security       │
└────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────┐
│  @openicf/connector-core           │
│                                    │
│  Built-in protections:             │
│  ✅ Circuit breaker                │
│  ✅ Rate limiter                   │
│  ✅ Input validation (Zod)         │
│  ✅ Resource pooling               │
│                                    │
│  ❌ No network security needed     │
└────────────────────────────────────┘
```

### WebSocket Package (Network)

```
┌────────────────────────────────────────────────────────┐
│              Control Plane (Client)                    │
└────────────────────────────────────────────────────────┘
                        │
                    [TLS/WSS]
                        │
                        ▼
┌────────────────────────────────────────────────────────┐
│         @openicf/connector-websocket                   │
│                                                        │
│  Security Layers:                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │ 1. TLS/WSS Transport Encryption              │    │
│  └──────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────┐    │
│  │ 2. OAuth 2.0 Client Credentials              │    │
│  │    - Token validation                        │    │
│  │    - Auto refresh (30s buffer)               │    │
│  │    - Expiry monitoring                       │    │
│  └──────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────┐    │
│  │ 3. CSRF Protection                           │    │
│  │    - Origin validation                       │    │
│  │    - Reject cross-origin                     │    │
│  └──────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────┐    │
│  │ 4. Rate Limiting                             │    │
│  │    - Token bucket: 5/sec, burst 20           │    │
│  │    - Different costs per message type        │    │
│  └──────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────┐    │
│  │ 5. Input Validation                          │    │
│  │    - Message schema validation               │    │
│  │    - Payload sanitization                    │    │
│  └──────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────┐
│            @openicf/connector-core                     │
│                                                        │
│  Additional protections:                               │
│  ✅ Circuit breaker                                    │
│  ✅ Rate limiter                                       │
│  ✅ Resource pooling                                   │
└────────────────────────────────────────────────────────┘
```

## Performance Characteristics

| Operation | Monolith HTTP | Core (Local) | WebSocket (Remote) |
|-----------|---------------|--------------|---------------------|
| **Simple Get** | 10-50ms | 0.01-0.1ms | 10-50ms |
| **Search (100 items)** | 50-200ms | 1-10ms | 50-200ms |
| **Bulk Create (1000)** | 1-5s | 0.1-1s | 1-5s |
| **Cold Start** | 500ms | 10ms | 500ms + OAuth |
| **Memory (Base)** | 50MB | 5MB | 30MB |
| **Memory (Per Connector)** | 1-5MB | 1-5MB | 1-5MB |

**Key Insight**: Core library is **100-1000x faster** for local operations due to elimination of network serialization/deserialization overhead.

## Summary

The split architecture provides:

1. **Clear Separation**: Transport-independent core vs transport-specific servers
2. **Flexibility**: Choose local or remote based on use case
3. **Performance**: Direct local calls when network not needed
4. **Maintainability**: Independent packages with clear boundaries
5. **Extensibility**: Easy to add new transports (HTTP, gRPC, etc.)
6. **Security**: Appropriate security model for each deployment type

This design follows industry best practices for library/framework architecture and enables both embedded and distributed deployment models.
