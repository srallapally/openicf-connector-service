# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is an npm workspace monorepo rooted at `../../` (two levels above this file). The working directory for Claude Code sessions is `packages/core`, but the full tree is:

```
openicf-connector-service/      <- workspace root
├── packages/
│   ├── core/                   <- @openicf/connector-core  (this package)
│   └── websocket/              <- @openicf/connector-websocket  (deployable WS server)
├── src/                        <- legacy root-level utilities (not built)
└── test/                       <- legacy root-level tests (not built)
```

`packages/websocket` depends on `packages/core` via `file:../core`. Core is a transport-independent library; websocket is the deployable binary.

## Commands

Run from the **workspace root** (`../../` relative to this file) unless noted.

```bash
# Install
npm ci

# Build all packages (TypeScript project references)
npm run build

# Build only this package
npm run build          # from packages/core

# Clean dist output
npm run clean

# Run all tests
npm test

# Run tests for one package
cd packages/core && npm test
cd packages/websocket && npm test

# Run a single test file
cd packages/websocket && npx vitest run test/auth.test.ts

# Watch mode (per package)
npm run test:watch

# Lint (non-fatal — eslint . || true)
npm run lint

# Start websocket server (dev, no compile)
cd packages/websocket && npm run dev
# Requires env: REMOTE_CONNECTOR_WS_URL, OAUTH_TOKEN_URL, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET
```

## Architecture

### Core package (`packages/core`)

The `@openicf/connector-core` package has five sub-systems:

- **SPI types** (`src/spi/types.ts`) — interfaces for every connector operation (`CreateOp`, `UpdateOp`, `DeleteOp`, `GetOp`, `SearchOp`, `SchemaOp`, `TestOp`, `SyncOp`, `ScriptOnConnectorOp`). The `ConnectorSpi` union type is what a connector plugin must implement.
- **Registry** (`src/registry/ConnectorRegistry.ts`) — stores connector factories keyed as `type@version`, resolves the best semver match, manages instance lifecycle.
- **Facade** (`src/registry/ConnectorFacade.ts`) — wraps every connector SPI with a `CircuitBreaker` and LRU cache. Schema ops are cached 5 min; get ops 30 s; write ops invalidate the cache. This is the only layer callers should interact with.
- **Infra** (`src/infra/`) — standalone resilience primitives:
  - `CircuitBreaker`: CLOSED/OPEN/HALF_OPEN states; 5 failure threshold, 2 success threshold to close, 10 s half-open window, 20 concurrent max, 30 s timeout.
  - `RateLimiter`: token-bucket; 20 max tokens, refill 5/s.
  - `Cache`: LRU backed by `lru-cache`; 10 k entries, 60 s TTL.
  - `Pool`: connection pool via `tarn`; min 0, max 10, 5 s acquire, 30 s idle.
- **Loader** (`src/loader/ExternalLoader.ts`) — scans a directory for subdirectories with `manifest.json`. Dynamically imports each connector factory, resolves `${ENV_VAR}` substitutions in config, registers factory and instantiates named instances from `manifest.instances`.

### WebSocket package (`packages/websocket`)

The `@openicf/connector-websocket` package is the deployable runtime. It connects **outbound** to a remote control plane WebSocket URL rather than exposing a server port.

- **`RemoteConnectorService`** (`src/server/RemoteConnectorService.ts`) — manages the persistent WS connection; authenticates on connect via OAuth client_credentials; dispatches `ping`, `list-connectors`, and `operation` messages through the facade; rate-limits per-message; proactively reconnects 5 min before token expiry; exponential backoff on disconnect (1 s → 30 s).
- **`OAuthTokenProvider`** (`src/server/OAuthTokenProvider.ts`) — client credentials grant with 30 s early-expiry caching.
- **Security middleware** (`src/security/`):
  - `auth.ts` — Express JWT middleware via `jose`; validates JWKS, algorithm allowlist, iss/aud, clock skew; replay prevention via `TokenReplayCache` (LRU, 10 k, 1 h TTL cap); optional JTI requirement.
  - `csrf.ts` — double-submit cookie pattern with HMAC-SHA256 signed tokens; origin validation including WebSocket origin.
  - `hardening.ts` — helmet, CORS, express-rate-limit (300 req/min), Zod input validation, 512 kb body limit, sensitive-field sanitisation.

### TypeScript configuration

`target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`. The websocket package extends `../core/tsconfig.json`. Both packages use composite/incremental builds with project references from the root `tsconfig.json`.
