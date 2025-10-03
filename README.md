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

## UpdateAttributeValues endpoints
- `POST /connectors/{id}/{objectClass}/{uid}/_addAttributeValues` — body: `{ "attrs": { ... }, "options": { ... } }`
- `POST /connectors/{id}/{objectClass}/{uid}/_removeAttributeValues` — body: `{ "attrs": { ... }, "options": { ... } }`

## Sync endpoint
- `POST /connectors/{id}/_sync` — returns **501** if connector doesn't implement SyncOp.
