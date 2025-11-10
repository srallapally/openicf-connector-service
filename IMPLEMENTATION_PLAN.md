# OpenICF Connector Service - Split Implementation Plan

## ⚠️ IMPORTANT WARNING

**DO NOT apply these changes to the current codebase yet!**

This is an implementation plan for the PROPOSED architecture described in `DESIGN_SPLIT_ARCHITECTURE.md`.

**Prerequisites before starting:**
1. ✅ Design documents reviewed and approved
2. ✅ Stakeholder sign-off obtained
3. ✅ Full backup of current codebase created
4. ✅ New feature branch created for implementation

**If you haven't completed the above, STOP and review the design first!**

---

## Overview

This document provides step-by-step instructions for implementing the architectural split outlined in `DESIGN_SPLIT_ARCHITECTURE.md`.

## Quick Summary: What This Plan Does

This plan transforms the current monolithic structure:
```
src/
├── core/
├── spi/
├── server/
└── ...
```

Into a workspace monorepo:
```
packages/
├── core/           (@openicf/connector-core)
└── websocket/      (@openicf/connector-websocket)
```

## Critical Order of Operations

**You MUST follow this exact order:**

1. **Phase 1**: Create directory structure and package.json files
   - ⚠️ Root package.json will be replaced (backup first!)
   - Create packages/core/package.json
   - Create packages/websocket/package.json

2. **Phase 2**: Copy code files to new locations
   - NO npm install yet!

3. **Phase 3**: Copy test files to new locations
   - NO npm install yet!

4. **Phase 4**: NOW run npm install (workspace dependencies will resolve)
   - Build packages
   - Run tests

5. **Phase 5**: Write documentation

6. **Phase 6**: Optional backward compatibility

7. **Phase 7**: Cleanup old files

**❌ DO NOT run `npm install` before completing Phases 1-3!**

The `workspace:*` dependency only works in a properly configured npm workspace.

## Prerequisites

- Node.js >= 20.12.0
- npm >= 10.0.0 (for workspace support)
- Git
- Understanding of the current codebase
- **Current codebase backed up**
- **New implementation branch created**

## Phase 1: Workspace Setup

### ⚠️ Phase 1 Warning
Phase 1 will restructure your package.json and create a monorepo. Make sure you have:
- Created a backup: `git stash` or `git branch backup-$(date +%Y%m%d)`
- Created implementation branch: `git checkout -b feature/split-architecture`

### Step 1.1: Create Workspace Structure

```bash
# Create packages directory
mkdir -p packages/core/src
mkdir -p packages/core/test
mkdir -p packages/websocket/src
mkdir -p packages/websocket/test

# Create directory structure for core package
mkdir -p packages/core/src/registry
mkdir -p packages/core/src/infrastructure
mkdir -p packages/core/src/spi
mkdir -p packages/core/src/filter
mkdir -p packages/core/src/loader

# Create directory structure for websocket package
mkdir -p packages/websocket/src/server
mkdir -p packages/websocket/src/security
```

### Step 1.2: Backup and Replace Root package.json

**⚠️ CRITICAL: This will replace your current package.json!**

First, backup the current package.json:

```bash
# Backup current package.json
cp package.json package.json.backup
git add package.json.backup
git commit -m "backup: Save current package.json before workspace migration"
```

Then, **completely replace** the root `package.json` with this new workspace configuration:

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

### Step 1.3: Create Core Package Configuration

Create `packages/core/package.json`:

```json
{
  "name": "@openicf/connector-core",
  "version": "1.0.0",
  "description": "OpenICF Connector Core Library - Transport-independent connector framework",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./registry": {
      "import": "./dist/registry/index.js",
      "types": "./dist/registry/index.d.ts"
    },
    "./infrastructure": {
      "import": "./dist/infrastructure/index.js",
      "types": "./dist/infrastructure/index.d.ts"
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
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=20.12.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "rm -rf dist",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint . || true"
  },
  "keywords": [
    "openicf",
    "connector",
    "identity",
    "provisioning"
  ],
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

Create `packages/core/tsconfig.json`:

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

### Step 1.4: Create WebSocket Package Configuration

Create `packages/websocket/package.json`:

**Note about `"workspace:*"` dependency:**
- This special npm/yarn/pnpm protocol links to the local `packages/core` directory
- It only works AFTER you complete Step 1.2 (workspace setup)
- npm will automatically resolve it to the local package
- This is NOT a regular npm package version

```json
{
  "name": "@openicf/connector-websocket",
  "version": "1.0.0",
  "description": "OpenICF Connector WebSocket Server - Remote connector invocation via WebSocket",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "openicf-websocket": "./dist/index.js"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=20.12.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "rm -rf dist",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint . || true"
  },
  "keywords": [
    "openicf",
    "connector",
    "websocket",
    "remote"
  ],
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
    "tsx": "^4.16.2",
    "vitest": "^3.2.4",
    "supertest": "^7.0.0",
    "@types/supertest": "^2.0.16"
  }
}
```

Create `packages/websocket/tsconfig.json`:

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

## Phase 2: Code Migration

### Step 2.1: Move Core Files

Move core functionality to `packages/core/src/`:

```bash
# Registry
cp src/core/ConnectorRegistry.ts packages/core/src/registry/
cp src/core/ConnectorFacade.ts packages/core/src/registry/

# Infrastructure
cp src/core/CircuitBreaker.ts packages/core/src/infrastructure/
cp src/core/Cache.ts packages/core/src/infrastructure/
cp src/core/RateLimiter.ts packages/core/src/infrastructure/
cp src/core/Pool.ts packages/core/src/infrastructure/

# SPI
cp src/spi/types.ts packages/core/src/spi/
cp src/spi/icf-compat.ts packages/core/src/spi/
cp src/spi/configuration.ts packages/core/src/spi/
cp src/spi/schema.ts packages/core/src/spi/

# Filter
cp src/filter/ast.ts packages/core/src/filter/
cp src/filter/validate.ts packages/core/src/filter/
cp src/filter/sql.ts packages/core/src/filter/

# Loader
cp src/loader/ExternalLoader.ts packages/core/src/loader/
```

### Step 2.2: Update Import Paths in Core

Update all imports in `packages/core/src/` to use relative paths:

**Example: packages/core/src/registry/ConnectorFacade.ts**

```typescript
// Before:
import type { ConnectorSpi, OperationOptions } from "../spi/types.js";
import { CircuitBreaker } from "./CircuitBreaker.js";
import { Cache } from "./Cache.js";

// After:
import type { ConnectorSpi, OperationOptions } from "../spi/types.js";
import { CircuitBreaker } from "../infrastructure/CircuitBreaker.js";
import { Cache } from "../infrastructure/Cache.js";
```

### Step 2.3: Create Core Package Index

Create `packages/core/src/index.ts`:

```typescript
// Registry & Facade
export { ConnectorRegistry } from './registry/ConnectorRegistry.js';
export { ConnectorFacade } from './registry/ConnectorFacade.js';
export type { ConnectorInstance } from './registry/ConnectorRegistry.js';

// Infrastructure
export { CircuitBreaker } from './infrastructure/CircuitBreaker.js';
export { Cache } from './infrastructure/Cache.js';
export { RateLimiter } from './infrastructure/RateLimiter.js';
export { Pool } from './infrastructure/Pool.js';

// SPI - Export all types
export type * from './spi/types.js';
export type * from './spi/icf-compat.js';
export type * from './spi/configuration.js';
export * from './spi/schema.js';

// Filter utilities
export { parseFilter, validateFilter } from './filter/validate.js';
export { filterToSql } from './filter/sql.js';
export type * from './filter/ast.js';

// External loader
export { loadExternalConnectors } from './loader/ExternalLoader.js';
```

Create submodule indexes:

**packages/core/src/registry/index.ts:**
```typescript
export { ConnectorRegistry } from './ConnectorRegistry.js';
export { ConnectorFacade } from './ConnectorFacade.js';
export type { ConnectorInstance } from './ConnectorRegistry.js';
```

**packages/core/src/infrastructure/index.ts:**
```typescript
export { CircuitBreaker } from './CircuitBreaker.js';
export { Cache } from './Cache.js';
export { RateLimiter } from './RateLimiter.js';
export { Pool } from './Pool.js';
```

**packages/core/src/spi/index.ts:**
```typescript
export type * from './types.js';
export type * from './icf-compat.js';
export type * from './configuration.js';
export * from './schema.js';
```

**packages/core/src/filter/index.ts:**
```typescript
export { parseFilter, validateFilter } from './validate.js';
export { filterToSql } from './sql.js';
export type * from './ast.js';
```

**packages/core/src/loader/index.ts:**
```typescript
export { loadExternalConnectors } from './ExternalLoader.js';
```

### Step 2.4: Move WebSocket Files

Move WebSocket-related files to `packages/websocket/src/`:

```bash
# Create server directory and move WebSocket implementation
mkdir -p packages/websocket/src/server

# Split websocket.ts into multiple files for better organization
# We'll do this manually to separate concerns
```

Create `packages/websocket/src/server/OAuthTokenProvider.ts`:

```typescript
export interface OAuthOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string | undefined;
  audience?: string | undefined;
  resource?: string | undefined;
}

export class OAuthTokenProvider {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private readonly earlyExpiryMs = 30_000;

  constructor(private readonly opts: OAuthOptions) {}

  invalidate() {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  private isTokenValid() {
    return this.accessToken && Date.now() + this.earlyExpiryMs < this.expiresAt;
  }

  getTokenExpiryTime(): number {
    return this.expiresAt;
  }

  async getToken(): Promise<string> {
    if (this.isTokenValid()) return this.accessToken!;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    if (this.opts.scope) body.set("scope", this.opts.scope);
    if (this.opts.audience) body.set("audience", this.opts.audience);
    if (this.opts.resource) body.set("resource", this.opts.resource);

    const res = await fetch(this.opts.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OAuth token request failed (${res.status} ${res.statusText}): ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as Record<string, unknown>;
    const token = typeof json.access_token === "string" ? json.access_token : null;
    if (!token) throw new Error("OAuth token response missing access_token");

    const expires = typeof json.expires_in === "number"
      ? json.expires_in
      : typeof json.expires_in === "string"
        ? Number.parseInt(json.expires_in, 10)
        : null;
    const expiresInSec = Number.isFinite(expires) && expires! > 0 ? expires! : 300;

    this.accessToken = token;
    this.expiresAt = Date.now() + expiresInSec * 1000;
    return token;
  }
}
```

Copy and update security files:

```bash
# Security
mkdir -p packages/websocket/src/security
cp src/server/auth.ts packages/websocket/src/security/
cp src/server/csrf.ts packages/websocket/src/security/
cp src/server/hardening.ts packages/websocket/src/security/
```

### Step 2.5: Create WebSocket Package Index

Create `packages/websocket/src/index.ts`:

```typescript
#!/usr/bin/env node

import { ConnectorRegistry } from '@openicf/connector-core';
import { loadExternalConnectors } from '@openicf/connector-core/loader';
import { RemoteConnectorService } from './server/RemoteConnectorService.js';
import { OAuthTokenProvider } from './server/OAuthTokenProvider.js';

function getArgValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name) {
      return i + 1 < argv.length ? argv[i + 1] : undefined;
    }
    if (arg && arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

async function main() {
  const serverUrl = process.env.REMOTE_CONNECTOR_WS_URL;
  const tokenUrl = process.env.OAUTH_TOKEN_URL;
  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;

  if (!serverUrl) throw new Error("REMOTE_CONNECTOR_WS_URL must be set");
  if (!tokenUrl) throw new Error("OAUTH_TOKEN_URL must be set");
  if (!clientId) throw new Error("OAUTH_CLIENT_ID must be set");
  if (!clientSecret) throw new Error("OAUTH_CLIENT_SECRET must be set");

  const oauth = new OAuthTokenProvider({
    tokenUrl,
    clientId,
    clientSecret,
    scope: process.env.OAUTH_SCOPE,
    audience: process.env.OAUTH_AUDIENCE,
    resource: process.env.OAUTH_RESOURCE,
  });

  const registry = new ConnectorRegistry();

  const argv = process.argv.slice(2);
  const connectorsDir = getArgValue(argv, "--connectors") ?? process.env.CONNECTORS_DIR;
  if (connectorsDir) {
    console.log(`Loading external connectors from: ${connectorsDir}`);
    await loadExternalConnectors(connectorsDir, registry);
  } else {
    console.log("No external connectors directory provided. Use --connectors <dir> or CONNECTORS_DIR env.");
  }

  const service = new RemoteConnectorService({ serverUrl, registry, oauth });
  await service.start();

  const shutdown = async () => {
    console.log("Shutting down remote connector service");
    await service.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { main };

// Only run main if this is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

### Step 2.6: Update RemoteConnectorService Imports

Extract `RemoteConnectorService` from the original websocket.ts and update imports:

Create `packages/websocket/src/server/RemoteConnectorService.ts` - extract the class from original file and update imports:

```typescript
import type { IncomingMessage } from "node:http";
import WebSocket, { type RawData } from "ws";
import { ConnectorRegistry, ConnectorFacade } from '@openicf/connector-core';
import type { OperationOptions } from '@openicf/connector-core/spi';
import { RateLimiter } from '@openicf/connector-core/infrastructure';
import { loadCsrfConfig, validateWebSocketOrigin } from "../security/csrf.js";
import type { OAuthTokenProvider } from "./OAuthTokenProvider.js";

// ... rest of the RemoteConnectorService implementation
```

## Phase 3: Testing

### Step 3.1: Move Core Tests

```bash
# Move core tests
cp test/core/RateLimiter.test.ts packages/core/test/
```

Update test imports in `packages/core/test/RateLimiter.test.ts`:

```typescript
import { RateLimiter } from '../src/infrastructure/RateLimiter.js';
```

### Step 3.2: Move WebSocket Tests

```bash
# Move WebSocket tests
mkdir -p packages/websocket/test
cp test/server/auth.test.ts packages/websocket/test/
cp test/server/auth-config.test.ts packages/websocket/test/
cp test/server/jti-config.test.ts packages/websocket/test/
cp test/server/jti-requirement.test.ts packages/websocket/test/
cp test/server/websocket-auth.test.ts packages/websocket/test/
cp test/server/websocket-rate-limiting.test.ts packages/websocket/test/
cp test/server/hardening.test.ts packages/websocket/test/
```

Update test imports to use the new package structure:

```typescript
import { validateJwt } from '../src/security/auth.js';
```

### Step 3.3: Create Vitest Config

Create `packages/core/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

Create `packages/websocket/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

## Phase 4: Build & Verify

**Prerequisites for Phase 4:**
- ✅ All Phase 1 steps completed (workspace structure created)
- ✅ All Phase 2 steps completed (code migrated)
- ✅ All Phase 3 steps completed (tests migrated)

**Important:** Do NOT run `npm install` until ALL package.json files are in place!

### Step 4.1: Install Dependencies

**⚠️ This is when workspace dependencies will be resolved!**

```bash
# From repository root
npm install

# This will:
# 1. Install root devDependencies
# 2. Install dependencies for packages/core
# 3. Install dependencies for packages/websocket
# 4. Link @openicf/connector-core to packages/websocket automatically
```

**Expected output:**
```
added XXX packages, and audited YYY packages
```

**If you see `EUNSUPPORTEDPROTOCOL` error:**
- You haven't completed Phase 1 (workspace setup)
- The root package.json is missing the "workspaces" field
- You tried to run npm install before creating all package.json files

### Step 4.2: Build Packages

```bash
# Build core first (websocket depends on it)
npm run build -w @openicf/connector-core

# Build websocket
npm run build -w @openicf/connector-websocket

# Or build all packages
npm run build
```

### Step 4.3: Run Tests

```bash
# Test core package
npm run test -w @openicf/connector-core

# Test websocket package
npm run test -w @openicf/connector-websocket

# Or test all packages
npm run test
```

## Phase 5: Documentation

### Step 5.1: Create Core Package README

Create `packages/core/README.md`:

```markdown
# @openicf/connector-core

Transport-independent OpenICF connector framework for local invocation.

## Installation

\`\`\`bash
npm install @openicf/connector-core
\`\`\`

## Usage

\`\`\`typescript
import { ConnectorRegistry, ConnectorFacade } from '@openicf/connector-core';

// Create registry
const registry = new ConnectorRegistry();

// Register a connector
registry.registerFactory('my-connector', async (config) => ({
  async test() { /* ... */ },
  async schema() { /* ... */ },
  async create(objectClass, attributes, options) { /* ... */ },
}));

// Initialize instance
await registry.initInstance('conn1', 'my-connector', { /* config */ });

// Use the connector
const facade = new ConnectorFacade(registry.get('conn1').impl);
await facade.test();
const results = await facade.search('account', null);
\`\`\`

## Features

- Circuit breaker for fault tolerance
- LRU cache with TTL
- Token bucket rate limiter
- Resource pooling
- External connector loading
- Type-safe operations

## API Documentation

See [DESIGN_SPLIT_ARCHITECTURE.md](../../DESIGN_SPLIT_ARCHITECTURE.md) for full API documentation.
```

### Step 5.2: Create WebSocket Package README

Create `packages/websocket/README.md`:

```markdown
# @openicf/connector-websocket

WebSocket server for remote OpenICF connector invocation.

## Installation

\`\`\`bash
npm install @openicf/connector-websocket
\`\`\`

## Usage

### CLI

\`\`\`bash
export REMOTE_CONNECTOR_WS_URL=wss://control-plane.example.com/ws
export OAUTH_TOKEN_URL=https://auth.example.com/oauth/token
export OAUTH_CLIENT_ID=my-client
export OAUTH_CLIENT_SECRET=secret
export CONNECTORS_DIR=/path/to/connectors

npx openicf-websocket
\`\`\`

### Programmatic

\`\`\`typescript
import { RemoteConnectorService, OAuthTokenProvider } from '@openicf/connector-websocket';
import { ConnectorRegistry } from '@openicf/connector-core';

const registry = new ConnectorRegistry();
// ... configure connectors ...

const oauth = new OAuthTokenProvider({
  tokenUrl: process.env.OAUTH_TOKEN_URL!,
  clientId: process.env.OAUTH_CLIENT_ID!,
  clientSecret: process.env.OAUTH_CLIENT_SECRET!,
});

const service = new RemoteConnectorService({
  serverUrl: process.env.REMOTE_CONNECTOR_WS_URL!,
  registry,
  oauth,
});

await service.start();
\`\`\`

## Features

- OAuth 2.0 authentication
- Automatic token refresh
- Rate limiting
- CSRF protection
- Auto-reconnection
- Graceful shutdown

## Documentation

See [DESIGN_SPLIT_ARCHITECTURE.md](../../DESIGN_SPLIT_ARCHITECTURE.md) for architecture details.
```

## Phase 6: Backward Compatibility (Optional)

If you want to maintain backward compatibility during migration, create wrapper scripts:

### Step 6.1: Create Legacy HTTP Server Wrapper

Create `src/server/index-legacy.ts`:

```typescript
import { ConnectorRegistry } from '@openicf/connector-core';
// ... rest of legacy HTTP server code
```

Update `package.json` scripts:

```json
{
  "scripts": {
    "start:http": "node dist/server/index-legacy.js",
    "start:websocket": "npm run start -w @openicf/connector-websocket"
  }
}
```

## Phase 7: Cleanup

### Step 7.1: Remove Old Files

Once migration is complete and tested:

```bash
# Remove old src directory (after backing up)
rm -rf src/core
rm -rf src/spi
rm -rf src/filter
rm -rf src/loader
```

### Step 7.2: Update Git

```bash
git add packages/
git commit -m "feat: split project into core and websocket packages

- Created @openicf/connector-core package for local invocation
- Created @openicf/connector-websocket package for remote invocation
- Established monorepo structure using npm workspaces
- Migrated all code with updated import paths
- All tests passing"
```

## Verification Checklist

- [ ] All packages install dependencies successfully
- [ ] Core package builds without errors
- [ ] WebSocket package builds without errors
- [ ] All core tests pass
- [ ] All WebSocket tests pass
- [ ] Core package can be imported and used standalone
- [ ] WebSocket package successfully uses core package
- [ ] README files are complete
- [ ] Type declarations are generated
- [ ] No circular dependencies
- [ ] No import errors
- [ ] Package exports are correct

## Troubleshooting

### Issue: Cannot find module '@openicf/connector-core'

**Solution**: Make sure you've installed dependencies and built the core package first:

```bash
npm install
npm run build -w @openicf/connector-core
```

### Issue: Type errors in websocket package

**Solution**: Ensure TypeScript project references are set up correctly:

```bash
# Build core first to generate type declarations
npm run build -w @openicf/connector-core
```

### Issue: Tests failing after migration

**Solution**: Check that all import paths have been updated:

```bash
# Search for old import patterns
grep -r "from.*\\.\\./core/" packages/
grep -r "from.*\\.\\./spi/" packages/
```

## Next Steps

After completing the implementation:

1. Update CI/CD pipeline to build and test both packages
2. Add integration tests
3. Create example applications
4. Publish to npm registry (if desired)
5. Update main repository documentation
6. Announce migration to users
