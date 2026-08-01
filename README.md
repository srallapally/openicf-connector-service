# Governance Connector Framework (Node/TypeScript)

A transport-independent connector runtime for identity governance workflows.
The SPI design draws on the OpenICF/ICF connector model.

- External connector loader (pass `--connectors <dir>` at startup)
- JWT Bearer auth, rate limits, secure headers
- Circuit breaker, opt-in caching, connection pooling
- **Asynchronous provisioning**: durable operation table, lane serialization, attempt deadlines, and a three-outcome resolution protocol — see [Async provisioning](#async-provisioning)
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

Mutations (`create`, `update`, `delete`, `addValues`, `removeValues`) are
asynchronous. Reads (`get`, `search`, `sync`) stay synchronous — they have a
caller waiting on the answer and nothing to make durable.

A mutation is recorded in a durable operation table and drained by a
dispatcher, so the answer survives a restart and the caller is never left
holding a connection open against a slow target.

**This package supplies the machinery, not the HTTP surface.** It exports
`admitAndEnqueue` (the enqueue-plus-admission gate), `Dispatcher` (the drain
loop), and `OperationStore.getStatus` (the status query). The embedding service
owns the transport and is expected to answer `202` with the returned
`operationId`, expose a status route backed by `getStatus`, and map
`AdmissionRejectedError` to `429`.

### Outcome taxonomy

Four terminal outcomes. The three failures are deliberately distinct, because
the remedy differs for each — collapsing them is what produces duplicate
accounts.

| Outcome | Meaning | What to do |
| --- | --- | --- |
| `SUCCEEDED` | The target applied the change. A create carries the target-minted `uid` in `result`. | Nothing. |
| `REJECTED_PRE_DISPATCH` | Never reached the target: admission cap, open breaker, or unbuildable connector. | Safe to retry wholesale; nothing happened. |
| `FAILED_CONFIRMED` | The target answered and refused. | Retrying the same payload reproduces the refusal. Fix the request. |
| `INDETERMINATE` | The attempt deadline expired with no answer. The target may or may not have applied it. | Reconciliation. **Do not blind-retry.** |

Non-terminal statuses are `PENDING`, `RUNNING`, and `AWAITING_READBACK` — a
create whose deadline expired and which is waiting out the delay before its
read-back. A deferred row holds no mutation slot and no connector lease, only
its lane. A row is terminal exactly when its status is one of the four above,
and the database derives that rather than enumerating it, so adding a status
cannot silently miss the partition-drop gate.

### Resolution protocol

- **DELETE** — `UNKNOWN_UID` resolves to `SUCCEEDED`: the desired end state is
  "absent", and it is absent. Retryable errors and deadlines retry with
  exponential backoff (5 attempts, 1s doubling to 60s), then `INDETERMINATE`.
- **UPDATE** — always a full replace, which is idempotent by construction, so
  it retries freely on a deadline or a retryable error.
- **ADD_VALUES / REMOVE_VALUES** — deltas against a multi-valued attribute,
  modelled on ICF's `UpdateAttributeValuesOp`. They require a `uid` and share
  the uid lane with update and delete, so a grant and a revoke on one account
  cannot overlap.

  A delta retries **only** when the manifest declares `idempotentDelta`;
  otherwise a deadline records `INDETERMINATE` and leaves it to
  reconciliation. Against a set-valued attribute a replayed grant is a no-op;
  against a list-valued one it is a *second grant*, and for entitlements that
  is a silent privilege change. Only the connector knows which it is, so an
  absent assertion reads as "not safe".

  There is no read-back for deltas: unlike a create there is no naming
  attribute to search on and no existence question to ask.
- **CREATE** — success persists the minted `uid` and the returned object. A
  deadline parks the operation as `AWAITING_READBACK` until the attempt
  deadline plus a grace period has passed, then searches by the naming
  attribute. Found resolves `SUCCEEDED` with the discovered `uid`; a confirmed
  miss retries exactly once; a connector without `equalitySearchOnName` records
  `INDETERMINATE` immediately and leaves it to reconciliation. `ALREADY_EXISTS`
  is `FAILED_CONFIRMED`.

  The wait is a deferral, not a sleep: the operation gives up its slot and
  lease and is reclaimed when due. A resumed row searches and never re-issues
  the create, which is what keeps a slow target from converting its own
  timeouts into lost throughput.

### Lanes

Operations against the same object never run concurrently. The lane key is
`create:<objectClass>:<nameAttrValue>` for creates (the Uid does not exist yet
— the target mints it) and `uid:<objectClass>:<uid>` for updates and deletes.

### Admission and backpressure

Backlog depth *is* the flow-control signal. Each instance has a `PENDING` cap
per priority class — 10000 batch, 1000 interactive by default. Over the cap,
`admitAndEnqueue` throws `AdmissionRejectedError` carrying the observed depth;
map it to `429` and return the depth so the caller knows how far behind it is.

The check is advisory under concurrency by design: serializing every enqueue to
make the cap exact would cost more than the small overshoot it prevents.

### Priority

`OperationOptions.priority` is `interactive` or `batch`, defaulting to `batch`.
It is supplied by the caller, never inferred: ICF has no bulk form, so a
reconciliation write and a helpdesk write are byte-identical on the wire.
Interactive work may draw on an instance's whole mutation budget; batch work is
capped at the budget minus a reserved slice, so a large reconciliation backlog
cannot starve a human-facing write.

### Runtime configuration

Per-instance, under a `runtime` block on the instance definition. Separate from
`config`, which is the connector's own settings and is never mixed with these.

| Setting | Default | Bounds |
| --- | --- | --- |
| `attemptDeadlineMs` | `3000` | 1–120000, per-op or a single value. `-1` and `0` are rejected at validation |
| `mutationConcurrency` | `10` | ≥ 1 |
| `readConcurrency` | `10` | ≥ 1 |
| `interactiveSliceFraction` | `0.2` | 0–1; `ceil()`, at least 1 slot for any positive fraction once the budget is ≥ 2. `0` means no reservation |
| `rateLimits` | off | optional per op: `{ requestLimit, requestPeriodMs, requestTimeoutMs? }` |
| `readCache` | off | optional `{ ttlMs, max }`; `get` only, TTL expiry, no write invalidation |

```jsonc
{
  "id": "ad-prod",
  "config": { "host": "${AD_HOST}" },
  "runtime": {
    "attemptDeadlineMs": { "create": 30000, "search": 60000 },
    "mutationConcurrency": 4,
    "interactiveSliceFraction": 0.25
  }
}
```

`-1` is rejected rather than treated as "no timeout": a hung target would hold
its lane slot until the process restarts. Targets in the Workday/SAP class need
an explicit operator override, and their connector should document expected
write latency.

Reads are **not** cached unless `readCache` is set. The previous default cost a
measured 2.45ms invalidation scan on every write, allocated per facade whether
or not anything was cached, and could not be correct across replicas.

### Crash recovery

A dispatcher killed mid-attempt leaves its claimed rows `RUNNING`, where no
claim query would ever find them again. A reaper returns any row claimed longer
ago than `reaperThresholdMs` (default 10 minutes) to the backlog.

Routing follows the same reasoning as the resolution protocol: an abandoned
create's outcome is unknown, so it goes to the read-back path rather than being
re-issued; update and delete are idempotent and return straight to `PENDING`.
Neither charges the operation an attempt — the process died, which is not the
operation's fault.

The threshold **must exceed** the instance's deadline ceiling plus the
read-back grace. Reclaiming work that is still running puts two dispatchers on
one mutation, which is worse than the stranded row it would be fixing.
Concurrent replicas serialize on an advisory lock, so a pass is done once.

### Operation table and retention

`packages/core/src/ops/schema.sql`. Range-partitioned by `created_at`, one
partition per day, so ageing data out is a `DROP` rather than a bulk `DELETE`.

The hot table holds a **24 hour** resolution window by default. Dropping a
partition is gated on it containing zero non-terminal rows — a `PENDING` or
`RUNNING` row is an operation someone was promised an answer for. Use
`drop_operations_partition(day)`, which enforces the gate and returns `false`
rather than cascading.

```sql
SELECT create_operations_partition(current_date + 1);  -- provision tomorrow
SELECT drop_operations_partition(current_date - 2);    -- refuses if any row is live
```

`operations_history` is narrow, unpartitioned, and permanent. It keeps the
`uid` — a create's target-minted Uid is the one fact that must outlive
retention, since without it a successful create is unlinkable to the account it
made — and deliberately carries **no** payload.

**Deployments needing payload-level audit MUST export `attrs`/`result` to GCS
before the partition ages out.** After 24 hours the slim history row is all
that remains, and it is not a forensic record.

The primary key is `(id, created_at)` because PostgreSQL requires the partition
key in every unique key on a partitioned table. Callers still address
operations by `id` alone.

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
`ConnectorManager` and `Dispatcher`.

Backlog depth and oldest-pending age are the two signals to alert on: a large
backlog that is draining is healthy, and a small one that is not is not.
Event-loop lag is emitted via `monitorEventLoopDelay` and is the measurement
that decides whether the dispatcher ever needs to move to a sidecar.

### Testing against PostgreSQL

The suite never requires a database — the operation-store contract runs against
an in-memory implementation, and the PostgreSQL suites skip when
`DATABASE_URL` is unset.

```bash
eval "$(bash scripts/test-pg.sh)"          # boots a throwaway cluster, exports DATABASE_URL
npm test -w @governance-connector-framework/core

npx tsx packages/core/test/load/soak.ts    # manual load run
```

Both stores are held to the same contract suite, which is the only thing
keeping the in-memory double from drifting from the real one.
