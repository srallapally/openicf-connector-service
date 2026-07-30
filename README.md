# Governance Connector Framework (Node/TypeScript)

A transport-independent connector runtime for identity governance workflows.
The SPI design draws on the OpenICF/ICF connector model.

- External connector loader (pass `--connectors <dir>` at startup)
- JWT Bearer auth, rate limits, secure headers
- Circuit breaker, bounded caching, pool helper
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
