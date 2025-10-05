# ICF-Inspired Connector Service

The ICF-Inspired Connector Service is an Express 5 + TypeScript application that hosts ICF-compatible connectors with hardened defaults, JWT Bearer authentication, and runtime discovery of external connector bundles for identity workloads.

It targets Node.js 20.12 or newer and ships npm scripts for development, builds, and production startup.

## Features

- **JWT-protected API** — Validates access tokens against a remote JWKS endpoint, issuer, audience, optional scopes, and guards against replay via `jti` caching.
- **Security-by-default middleware** — Helmet, strict CORS, rate limiting, body-size caps, request timeout headers, and JSON payload validation help protect upstream connectors.
- **Rich connector surface** — REST routes expose introspection, schema/test probes, CRUD, search, sync, and attribute value update operations, plus a catalog of loaded connector types/versions.
- **ICF-compatible SPI** — Connectors can implement the Create/Update/Delete/Get/Search/Sync core plus optional operations such as script execution, batch processing, complex attributes, and event subscriptions.
- **Operational helpers** — Circuit breaker, TTL cache, and async resource pool utilities support robust connector integrations.

## Getting Started

```bash
npm ci
npm run build
npm run start    # serves dist/server/index.js
```

Use `npm run dev` for the TypeScript watch mode entry point.

Set the connectors directory via `--connectors <path>` or the `CONNECTORS_DIR` environment variable before starting the service.

The server listens on `PORT` (default `8080`) and supports Express’s `trust proxy` tuning through the `TRUST_PROXY` environment variable.

## Configuration

| Variable | Purpose |
| --- | --- |
| `JWT_JWKS_URI` | Remote JWKS endpoint used to validate tokens. |
| `JWT_EXPECTED_ISS` / `JWT_EXPECTED_AUD` | Issuer and audience checks enforced on every token. |
| `JWT_ALLOWED_ALGS` | Comma-delimited algorithms (default `RS256,PS256,ES256`). |
| `JWT_ACCEPTED_CLOCK_SKEW_SEC` | Clock tolerance in seconds (default 60). |
| `JWT_REQUIRED_SCOPE` | Optional global scope requirement for all callers. |
| `CONNECTORS_DIR` | Directory containing connector manifests (same as `--connectors`). |
| `TRUST_PROXY` | Controls Express proxy trust behavior (number, list, CIDR, or boolean). |

## API Overview

Key routes under `/connectors` include:

- `GET /connectors` — List loaded connector IDs.
- `GET /connectors/:id` — Inspect connector metadata (type, version).
- `GET /connectors/_types` — Enumerate connector types and available semantic versions.
- `GET /connectors/:id/_schema` / `POST /_test` — Fetch schema or run health checks.
- CRUD routes: `POST /:objectClass`, `GET /:objectClass/:uid`, `PATCH /:objectClass/:uid`, `DELETE /:objectClass/:uid`.
- `POST /:objectClass/_search` and `POST /:objectClass/_sync` for discovery and synchronization workflows.
- Attribute value helpers: `POST /:uid/_addAttributeValues` and `_removeAttributeValues`.

All payloads are sanitized and validated with shared Zod schemas to enforce bounded filters, attributes, and paging options.

## Connector Packaging & Lifecycle

External connectors reside in a directory where each subfolder supplies a `manifest.json` describing the connector ID, type, semantic version, entry module, optional configuration builder, and pre-defined instances with per-instance overrides.

On startup the loader imports each manifest, registers its factory, merges base and instance configuration (including environment-variable substitutions), and instantiates every declared connector via the registry.

The `ConnectorRegistry` stores factories and configuration builders per `type@version`, validates configurations when available, instantiates connectors with contextual metadata, and exposes helpers for listing, fetching, and version discovery.

## Development Notes

- Security middleware disables default headers, rejects cross-origin browsers by default, enforces rate limiting, and caps JSON payloads to 512 KB.
- Filters, sync tokens, complex attributes, and optional operations mirror ICF semantics for interoperability with existing connectors.
- Use the provided utility modules (circuit breaker, cache, pool) to wrap outbound systems accessed by connectors.

## Testing

- ⚠️ `npm test` (not run; read-only review scope)
