# ICF-Inspired Connector Service (Node/TypeScript)

- External connector loader (pass `--connectors <dir>` at startup)
- JWT Bearer auth, rate limits, secure headers
- Circuit breaker, bounded caching, pool helper
- **ICF parity**: Configuration.validate(), OperationOptions, streaming SearchOp, optional extra ops (`AuthenticateOp`, `BatchOp`, `UpdateAttributeValuesOp`, `ScriptOnResourceOp`, event subscriptions)
- **Complex attributes supported** (ICF extension)

## Build & Run
```bash
npm ci
npm run build

# point to compiled external connectors dir
node dist/server/index.js --connectors ../external-connectors/dist
# or
CONNECTORS_DIR=../external-connectors/dist node dist/server/index.js
```

## Remote WebSocket Connector Service

The project now ships with a WebSocket-based runtime that connects to a remote
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

### Run

```bash
# assumes build output exists in dist/
node dist/server/websocket.js --connectors ../external-connectors/dist

# or run directly via tsx during development
npx tsx src/server/websocket.ts --connectors ../external-connectors/dist
```

On startup the WebSocket service loads external connectors, acquires an OAuth
access token, and establishes a WebSocket session. The control plane can:

- Send `ping` messages to receive `pong` replies with health metadata.
- Request the list of deployed connectors via `list-connectors`.
- Invoke connector operations (`create`, `update`, `delete`, `search`,
  `schema`, `test`, `sync`, `addAttributeValues`, `removeAttributeValues`,
  `scriptOnConnector`, etc.) and receive JSON responses.

## UpdateAttributeValues endpoints
- `POST /connectors/{id}/{objectClass}/{uid}/_addAttributeValues` — body: `{ "attrs": { ... }, "options": { ... } }`
- `POST /connectors/{id}/{objectClass}/{uid}/_removeAttributeValues` — body: `{ "attrs": { ... }, "options": { ... } }`

## Sync endpoint
- `POST /connectors/{id}/_sync` — returns **501** if connector doesn't implement SyncOp.
