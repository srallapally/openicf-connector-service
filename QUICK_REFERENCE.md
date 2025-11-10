# OpenICF Connector Split - Quick Reference Guide

## TL;DR

**Before**: Monolithic service - must use HTTP/WebSocket server for everything
**After**: Two packages:
- `@openicf/connector-core` - Use connectors locally (no server)
- `@openicf/connector-websocket` - Remote connector service via WebSocket

## Quick Decision Tree

```
Do you need to use connectors?
│
├─ YES, in the same process (local)
│  └─ Use: @openicf/connector-core
│     └─ npm install @openicf/connector-core
│
└─ YES, from remote clients (distributed)
   └─ Use: @openicf/connector-websocket
      └─ npm install @openicf/connector-websocket
```

## Installation

```bash
# For local invocation
npm install @openicf/connector-core

# For remote WebSocket server
npm install @openicf/connector-websocket
```

## Core Package (@openicf/connector-core)

### Basic Usage

```typescript
import {
  ConnectorRegistry,
  ConnectorFacade,
  loadExternalConnectors
} from '@openicf/connector-core';

// 1. Create registry
const registry = new ConnectorRegistry();

// 2. Register connector (inline)
registry.registerFactory('my-connector', async (config) => ({
  async test() { console.log('Testing...'); },
  async schema() { return { objectClasses: [...] }; },
  async create(objectClass, attrs) { return 'uid-123'; },
  async get(objectClass, uid) { return { uid, ... }; },
  async search(objectClass, filter, handler) { /* ... */ },
  // ... other operations
}));

// 3. Initialize instance
await registry.initInstance('conn1', 'my-connector', {
  host: 'example.com',
  port: 389,
});

// 4. Use connector
const connector = registry.get('conn1');
const facade = new ConnectorFacade(connector.impl);

await facade.test();
const uid = await facade.create('account', { username: 'jdoe' });
const account = await facade.get('account', uid);
const results = await facade.search('account', null);
```

### Loading External Connectors

```typescript
import { loadExternalConnectors } from '@openicf/connector-core';

await loadExternalConnectors('/path/to/connectors', registry);

// Directory structure:
// /path/to/connectors/
//   ├── my-connector/
//   │   ├── manifest.json
//   │   ├── factory.js
//   │   └── config-builder.js (optional)
```

### Available Exports

```typescript
// Registry & Facade
import {
  ConnectorRegistry,
  ConnectorFacade,
  type ConnectorInstance
} from '@openicf/connector-core';

// Infrastructure
import {
  CircuitBreaker,
  Cache,
  RateLimiter,
  Pool
} from '@openicf/connector-core/infrastructure';

// Types
import type {
  ConnectorSpi,
  ConnectorConfig,
  ConnectorObject,
  OperationOptions,
  Schema,
  // ... all SPI types
} from '@openicf/connector-core/spi';

// Filter utilities
import {
  parseFilter,
  validateFilter,
  filterToSql
} from '@openicf/connector-core/filter';

// External loader
import {
  loadExternalConnectors
} from '@openicf/connector-core/loader';
```

## WebSocket Package (@openicf/connector-websocket)

### CLI Usage

```bash
# Set environment variables
export REMOTE_CONNECTOR_WS_URL=wss://control-plane.example.com/ws
export OAUTH_TOKEN_URL=https://auth.example.com/oauth/token
export OAUTH_CLIENT_ID=your-client-id
export OAUTH_CLIENT_SECRET=your-client-secret
export OAUTH_SCOPE=connector:read,connector:write
export CONNECTORS_DIR=/path/to/connectors

# Run the service
npx openicf-websocket

# Or with CLI flag
npx openicf-websocket --connectors /path/to/connectors
```

### Programmatic Usage

```typescript
import {
  RemoteConnectorService,
  OAuthTokenProvider
} from '@openicf/connector-websocket';
import { ConnectorRegistry } from '@openicf/connector-core';

// 1. Setup registry
const registry = new ConnectorRegistry();
// ... register connectors ...

// 2. Setup OAuth
const oauth = new OAuthTokenProvider({
  tokenUrl: process.env.OAUTH_TOKEN_URL!,
  clientId: process.env.OAUTH_CLIENT_ID!,
  clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  scope: 'connector:read connector:write',
  audience: 'https://api.example.com',
});

// 3. Create and start service
const service = new RemoteConnectorService({
  serverUrl: process.env.REMOTE_CONNECTOR_WS_URL!,
  registry,
  oauth,
  reconnectInitialDelayMs: 1000,  // optional
  reconnectMaxDelayMs: 30000,     // optional
});

await service.start();

// 4. Graceful shutdown
process.on('SIGTERM', async () => {
  await service.shutdown();
  process.exit(0);
});
```

### Message Protocol

#### Client → Server

```json
// Ping
{
  "type": "ping",
  "requestId": "req-1"
}

// List connectors
{
  "type": "list-connectors",
  "requestId": "req-2"
}

// Execute operation
{
  "type": "operation",
  "requestId": "req-3",
  "connectorId": "ldap-connector",
  "operation": "search",
  "payload": {
    "objectClass": "account",
    "filter": null,
    "options": { "pageSize": 100 }
  }
}
```

#### Server → Client

```json
// Service info (on connect)
{
  "type": "service-info",
  "service": "openicf-connector-service",
  "startedAt": "2025-01-15T10:00:00Z",
  "connectors": ["ldap-connector", "db-connector"]
}

// Response (success)
{
  "type": "response",
  "requestId": "req-3",
  "success": true,
  "result": [...]
}

// Response (error)
{
  "type": "response",
  "requestId": "req-3",
  "success": false,
  "error": {
    "message": "Connection failed",
    "name": "ConnectorError"
  }
}
```

## Common Patterns

### Pattern 1: Simple Connector

```typescript
import { ConnectorRegistry, ConnectorFacade } from '@openicf/connector-core';

const registry = new ConnectorRegistry();

registry.registerFactory('simple', async (config) => ({
  async test() { /* test connection */ },
  async schema() { /* return schema */ },
  async create(objectClass, attrs, options) { /* create */ },
  async get(objectClass, uid, options) { /* get */ },
  async update(objectClass, uid, attrs, options) { /* update */ },
  async delete(objectClass, uid, options) { /* delete */ },
  async search(objectClass, filter, handler, options) {
    // Stream results
    for (const item of items) {
      const shouldContinue = handler(item);
      if (!shouldContinue) break;
    }
  },
}));

await registry.initInstance('simple1', 'simple', { /* config */ });
const facade = new ConnectorFacade(registry.get('simple1').impl);
```

### Pattern 2: Connector with Configuration

```typescript
import { Configuration } from '@openicf/connector-core/spi';

class MyConnectorConfig extends Configuration {
  @ConfigurationProperty({ required: true, displayName: 'Host' })
  host: string = '';

  @ConfigurationProperty({ required: true, displayName: 'Port' })
  port: number = 389;

  @ConfigurationProperty({ confidential: true })
  password: string = '';

  async validate() {
    if (!this.host) throw new Error('Host is required');
    if (this.port < 1 || this.port > 65535) {
      throw new Error('Port must be 1-65535');
    }
  }
}

registry.registerConfigBuilder('my-connector', async (raw) => {
  const config = new MyConnectorConfig();
  Object.assign(config, raw);
  return config;
});
```

### Pattern 3: Connector with Schema

```typescript
import { buildSchema } from '@openicf/connector-core/spi';

registry.registerFactory('with-schema', async (config) => ({
  async schema() {
    return buildSchema(b => {
      b.defineObjectClass('account', oc => {
        oc.addAttribute('username', { type: 'string', required: true });
        oc.addAttribute('email', { type: 'string' });
        oc.addAttribute('groups', { type: 'string', multiValued: true });
        oc.supportCreate().supportUpdate().supportDelete().supportSearch();
      });

      b.defineObjectClass('group', oc => {
        oc.addAttribute('name', { type: 'string', required: true });
        oc.addAttribute('members', { type: 'string', multiValued: true });
        oc.supportCreate().supportUpdate().supportDelete().supportSearch();
      });
    });
  },
  // ... other operations
}));
```

### Pattern 4: Using Circuit Breaker Directly

```typescript
import { CircuitBreaker } from '@openicf/connector-core/infrastructure';

const cb = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  halfOpenMaxCalls: 3,
});

// ConnectorFacade uses CircuitBreaker internally,
// but you can also use it directly
const result = await cb.exec(async () => {
  return await someOperation();
});

// Check circuit state
console.log(cb.getState()); // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
console.log(cb.getStats()); // { failures, successes, ... }
```

### Pattern 5: Using Cache Directly

```typescript
import { Cache } from '@openicf/connector-core/infrastructure';

const cache = new Cache<string>({
  maxSize: 1000,
  ttlMs: 60000, // 1 minute
});

cache.set('key', 'value');
const value = cache.get('key'); // 'value' or undefined if expired
cache.delete('key');
cache.clear();
```

### Pattern 6: Using Rate Limiter Directly

```typescript
import { RateLimiter } from '@openicf/connector-core/infrastructure';

// Token bucket: 10 tokens/sec, burst capacity of 50
const limiter = new RateLimiter(50, 10);

if (limiter.tryConsume(1)) {
  // Allowed
  await performOperation();
} else {
  // Rate limited
  throw new Error('Rate limit exceeded');
}

// Different costs for different operations
if (limiter.tryConsume(5)) { // Expensive operation
  await expensiveOperation();
}
```

## File Structure Reference

### Core Package Structure

```
packages/core/
├── src/
│   ├── registry/
│   │   ├── ConnectorRegistry.ts
│   │   ├── ConnectorFacade.ts
│   │   └── index.ts
│   ├── infrastructure/
│   │   ├── CircuitBreaker.ts
│   │   ├── Cache.ts
│   │   ├── RateLimiter.ts
│   │   ├── Pool.ts
│   │   └── index.ts
│   ├── spi/
│   │   ├── types.ts
│   │   ├── icf-compat.ts
│   │   ├── configuration.ts
│   │   ├── schema.ts
│   │   └── index.ts
│   ├── filter/
│   │   ├── ast.ts
│   │   ├── validate.ts
│   │   ├── sql.ts
│   │   └── index.ts
│   ├── loader/
│   │   ├── ExternalLoader.ts
│   │   └── index.ts
│   └── index.ts
├── test/
├── package.json
└── tsconfig.json
```

### WebSocket Package Structure

```
packages/websocket/
├── src/
│   ├── server/
│   │   ├── RemoteConnectorService.ts
│   │   ├── OAuthTokenProvider.ts
│   │   └── index.ts
│   ├── security/
│   │   ├── auth.ts
│   │   ├── csrf.ts
│   │   └── hardening.ts
│   └── index.ts
├── test/
├── package.json
└── tsconfig.json
```

## Environment Variables

### WebSocket Package

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `REMOTE_CONNECTOR_WS_URL` | ✅ Yes | WebSocket server URL | `wss://control-plane.example.com/ws` |
| `OAUTH_TOKEN_URL` | ✅ Yes | OAuth token endpoint | `https://auth.example.com/oauth/token` |
| `OAUTH_CLIENT_ID` | ✅ Yes | OAuth client ID | `my-client-id` |
| `OAUTH_CLIENT_SECRET` | ✅ Yes | OAuth client secret | `secret123` |
| `OAUTH_SCOPE` | ❌ No | OAuth scopes | `connector:read connector:write` |
| `OAUTH_AUDIENCE` | ❌ No | OAuth audience | `https://api.example.com` |
| `OAUTH_RESOURCE` | ❌ No | OAuth resource | `https://resource.example.com` |
| `CONNECTORS_DIR` | ❌ No | External connectors directory | `/opt/connectors` |

## Common Operations

### Test a Connector

```typescript
const facade = new ConnectorFacade(registry.get('my-connector').impl);
await facade.test(); // Throws if connection fails
```

### Get Schema

```typescript
const schema = await facade.schema();
console.log(schema.objectClasses);
```

### Create Object

```typescript
const uid = await facade.create('account', {
  username: 'jdoe',
  email: 'jdoe@example.com',
  firstName: 'John',
  lastName: 'Doe',
});
```

### Get Object

```typescript
const account = await facade.get('account', uid);
console.log(account.attributes);
```

### Update Object

```typescript
await facade.update('account', uid, {
  email: 'john.doe@example.com',
});
```

### Delete Object

```typescript
await facade.delete('account', uid);
```

### Search Objects

```typescript
// Simple search (all accounts)
const results = await facade.search('account', null);

// With filter
const results = await facade.search('account', {
  type: 'EQUALS',
  attribute: 'username',
  value: 'jdoe',
});

// With pagination
const results = await facade.search('account', null, {
  pageSize: 100,
  pageOffset: 0,
});
```

### Sync Changes

```typescript
// Initial sync
const syncResult = await facade.sync('account', null);

// Incremental sync using token
const nextResult = await facade.sync('account', syncResult.token);
```

### Add Multi-Valued Attributes

```typescript
await facade.addAttributeValues('account', uid, {
  groups: ['admin', 'developers'],
});
```

### Remove Multi-Valued Attributes

```typescript
await facade.removeAttributeValues('account', uid, {
  groups: ['developers'],
});
```

## TypeScript Types

### Key Types

```typescript
import type {
  // Core connector interface
  ConnectorSpi,

  // Configuration
  ConnectorConfig,
  Configuration,

  // Objects
  ConnectorObject,
  Uid,
  ObjectClassInfo,
  Schema,

  // Attributes
  AttributeValue,
  AttributeInfo,

  // Operations
  OperationOptions,
  CreateOp,
  UpdateOp,
  DeleteOp,
  GetOp,
  SearchOp,

  // Filters
  Filter,
  AttributeFilter,
  AndFilter,
  OrFilter,
  NotFilter,
} from '@openicf/connector-core/spi';
```

### Implementing a Connector

```typescript
import type { ConnectorSpi } from '@openicf/connector-core/spi';

class MyConnector implements ConnectorSpi {
  async test(): Promise<void> { /* ... */ }
  async schema(): Promise<Schema> { /* ... */ }
  async create(objectClass: string, attrs: Record<string, unknown>, options?: OperationOptions): Promise<string> { /* ... */ }
  async get(objectClass: string, uid: string, options?: OperationOptions): Promise<ConnectorObject | null> { /* ... */ }
  // ... other operations
}
```

## Testing

### Unit Test Example (Core)

```typescript
import { describe, it, expect } from 'vitest';
import { ConnectorRegistry, ConnectorFacade } from '@openicf/connector-core';

describe('MyConnector', () => {
  it('should create and retrieve account', async () => {
    const registry = new ConnectorRegistry();

    registry.registerFactory('test', async () => ({
      async test() {},
      async schema() { return { objectClasses: [] }; },
      async create(objectClass, attrs) {
        return 'uid-123';
      },
      async get(objectClass, uid) {
        return { uid, objectClass: 'account', attributes: {} };
      },
    }));

    await registry.initInstance('test1', 'test', {});
    const facade = new ConnectorFacade(registry.get('test1').impl);

    const uid = await facade.create('account', { username: 'test' });
    expect(uid).toBe('uid-123');

    const account = await facade.get('account', uid);
    expect(account?.uid).toBe('uid-123');
  });
});
```

## Troubleshooting

### Issue: Module not found

```
Error: Cannot find module '@openicf/connector-core'
```

**Solution**: Install dependencies and build packages

```bash
npm install
npm run build -w @openicf/connector-core
```

### Issue: Type errors

```
Type error: Cannot find type definitions
```

**Solution**: Build core package first to generate `.d.ts` files

```bash
npm run build -w @openicf/connector-core
```

### Issue: WebSocket connection fails

```
[ws] failed to get token or connect: OAuth token request failed
```

**Solution**: Verify OAuth environment variables

```bash
echo $OAUTH_TOKEN_URL
echo $OAUTH_CLIENT_ID
# Don't echo secret in production!
```

### Issue: Rate limit exceeded

```
[ws-rate-limit] Message rate limit exceeded
```

**Solution**: The WebSocket service limits messages to 5/sec sustained, 20 burst. Slow down requests or adjust rate limiter configuration.

## Migration Checklist

- [ ] Install core package: `npm install @openicf/connector-core`
- [ ] Update imports to use new package: `import { ... } from '@openicf/connector-core'`
- [ ] Replace HTTP calls with direct facade calls (if migrating to local)
- [ ] Update connector factory registrations
- [ ] Test all operations
- [ ] Update documentation
- [ ] Deploy and verify

## Additional Resources

- **Design Document**: `DESIGN_SPLIT_ARCHITECTURE.md` - Detailed architecture
- **Implementation Plan**: `IMPLEMENTATION_PLAN.md` - Step-by-step migration
- **Visual Guide**: `ARCHITECTURE_VISUAL.md` - Diagrams and comparisons
- **Examples**: See `examples/` directory (if available)
- **Tests**: See `packages/*/test/` for usage examples

## Quick Links

- Core Package: `packages/core/`
- WebSocket Package: `packages/websocket/`
- Tests: `packages/*/test/`
- Build: `npm run build`
- Test: `npm run test`
- Clean: `npm run clean`
