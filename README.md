# Governance Connector Framework (Node/TypeScript)

A transport-independent connector runtime for identity governance workflows.
The SPI design draws on the OpenICF/ICF connector model.

- External connector loader (pass `--connectors <dir>` at startup)
- JWT Bearer auth, rate limits, secure headers
- Circuit breaker, opt-in caching, connection pooling
- **Connector execution**: lazy instance lifecycle, refcounted leases, attempt deadlines with abort propagation, per-plane circuit breakers, connection pooling
- **Async provisioning moved out** — the operation table and dispatcher live in the provisioning service, see [Async provisioning](#async-provisioning)
- **ICF-compatible operations**: Configuration.validate(), OperationOptions, streaming SearchOp, optional extra ops (`AuthenticateOp`, `BatchOp`, `UpdateAttributeValuesOp`, `ScriptOnResourceOp`, event subscriptions)
- **Complex attributes supported**

## Monorepo Structure

```
governance-connector-framework/
├── packages/
│   ├── core/        # @governance-connector-framework/core  — transport-independent library
│   └── websocket/   # @governance-connector-framework/websocket  — deployable WebSocket service
```

`packages/websocket/src/security/` contains Express middlewares — `auth.ts`
(JWT bearer verification), `csrf.ts` and `hardening.ts`. They are retained and
tested for the server side of the WebSocket protocol, which lives outside this
repository. **No in-repo server mounts them**: this package is an outbound
client that dials a remote control plane.

## Build & Run

```bash
npm ci
npm run build

# Run the compiled WebSocket service
node packages/websocket/dist/index.js --connectors /path/to/connectors

# Or run via tsx during development
cd packages/websocket && npx tsx src/index.ts --connectors /path/to/connectors

# Or use the package dev script
cd packages/websocket && npm run dev
```

## Remote WebSocket Connector Service

The project ships a WebSocket-based runtime that connects to a remote
control plane using OAuth client credentials. The service authenticates during
the WebSocket handshake and keeps the session alive, allowing the remote server
to issue connector operations (create/update/delete/search, etc.) over the
socket.

### Environment variables

| Variable | Description |
| --- | --- |
| `REMOTE_CONNECTOR_WS_URL` | WebSocket endpoint exposed by the control plane. |
| `OAUTH_TOKEN_URL` | OAuth 2.0 token endpoint for client credentials. |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | Credentials used to fetch the access token. |
| `OAUTH_SCOPE` (optional) | Scope string sent with the token request. |
| `OAUTH_AUDIENCE` / `OAUTH_RESOURCE` (optional) | Additional audience/resource parameters. |
| `CONNECTORS_DIR` (optional) | Directory containing external connector manifests. |

On startup the WebSocket service loads external connectors, acquires an OAuth
access token, and establishes a WebSocket session. The control plane can:

- Send `ping` messages to receive `pong` replies with health metadata.
- Request the list of deployed connectors via `list-connectors`.
- Invoke connector operations (`create`, `update`, `delete`, `search`,
  `schema`, `test`, `sync`, `addAttributeValues`, `removeAttributeValues`,
  `scriptOnConnector`, etc.) and receive JSON responses.

## Async provisioning

Moved to the provisioning service (CP-5).

The operation table, dispatcher, admission gate, and the 202/status HTTP
contract are not part of this package. They describe a claim loop — deciding
what to dispatch and when — which is a different job from executing one
connector operation correctly.

What stays here is everything that job needs:

- the SPI and the ICF-aligned operation interfaces
- `ConnectorRegistry`, `ConnectorManager`, and leased `ConnectorFacade`s
- attempt deadlines, abort propagation, circuit breakers, connection pooling
- `ConnectorError` and the capability flags the resolution protocol reads
- test doubles under `@governance-connector-framework/core/testing`

A service embedding this package supplies the queue, the schedule, and the
transport. The framework supplies a correct single operation.

### Connector author obligations
1. **Honour `options.abortSignal`.** Forward it to your transport (`fetch`
   takes it directly). The framework stops waiting at the deadline regardless,
   but work that ignores the signal keeps consuming a slot and a connection
   until it settles on its own.
2. **Throw `ConnectorError`** with the most specific code you can justify.
   `UNKNOWN_UID` and `ALREADY_EXISTS` drive the resolution protocol directly.
   Unclassified errors resolve as `FAILED_CONFIRMED` when the target answered
   and `INDETERMINATE` when the deadline expired first.
3. **Declare capability flags in `manifest.json`.** All default `false`.

   | Flag | Meaning |
   | --- | --- |
   | `poolable` | Stateful protocol (LDAP, SQL, SSH); run through the connection pool. REST connectors should use an HTTP keep-alive agent instead — pooling buys them nothing. |
   | `idempotentDelta` | Delta updates survive being applied twice. Without it, a timed-out delta is never retried. |
   | `equalitySearchOnName` | Supports an equality filter on the naming attribute. Without it, a timed-out create cannot be read back and records `INDETERMINATE`. |

4. **Document expected write latency** if the target is slow. Operators size
   `attemptDeadlineMs` from it, and the 120s ceiling is not negotiable.
5. **Stream if you can.** Set `searchStreaming: true` and write into the
   supplied `ResultsHandler`. A handler returning `false` means stop — honour
   it, and the caller's backpressure reaches the target.

### Metrics

`MetricsSink` is an interface with `counter`/`gauge`/`histogram`; the default
discards everything and no client library is bundled. Pass one to
`ConnectorManager`.

Names cover what this package can observe on its own: breaker transitions, live
instance count, pool occupancy, and event-loop lag. Operation-level metrics
belong to whoever owns the claim loop.

### Testing

Test doubles ship as a subpath so connector authors do not each reinvent a
fake target:

```ts
import { makeFakeConnector, deferred } from "@governance-connector-framework/core/testing";
```

`makeFakeConnector` returns a real `ConnectorSpi` over an in-memory target:
creating a taken name throws `ALREADY_EXISTS` because the name is taken, and
deleting a missing uid throws `UNKNOWN_UID` because it is missing. Fault modes
cover latency, one-shot failures, hanging until aborted, and applying a
mutation and then never answering.

`vitest` is an optional peer dependency, needed only by the fake-clock helper.
Nothing in the main entry point imports it.
