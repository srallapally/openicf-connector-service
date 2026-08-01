<!-- CLAUDE_CODE_PLAN.md -->
# Implementation plan: async provisioning (feature/async-provisioning)

Repo: governance-connector-framework. Branch: `feature/async-provisioning` off `main@9136e57`.
Phase 1 of the SPI contract is already committed (OperationOptions: abortSignal, deadlineEpochMs, priority; OperationOutcome type).
Design authority: `governance-connector-framework_checkpoint_log.md` (CP-1, CP-2). If this plan and the log disagree, the log wins. Ask before deviating from any LOCKED item.

## Ground rules

- All work on `feature/async-provisioning`. Never commit to `main`.
- One phase per commit. Conventional commit messages: `feat(core): ...`, `test(core): ...`.
- `npm run build` must pass after every phase. `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on: optional properties use `| undefined`, index reads are checked.
- Do not modify `packages/websocket` except where a phase names it. Do not fix unrelated code. Match existing file style.
- No new runtime dependencies except `pg` (phase 4). Everything else uses what package.json already has (tarn, lru-cache, zod, semver).
- Each phase lists acceptance checks. Run them before committing.

## Decided constants (from CP-2, do not re-decide)

| Setting | Default | Bounds | Scope |
|---|---|---|---|
| attemptDeadlineMs | 3000 | 1..120000, reject -1/0 at config validation | per instance, per op type |
| mutationConcurrency | 10 | >=1 | per instance |
| readConcurrency | 10 | >=1 | per instance |
| interactiveSliceFraction | 0.2 | 0..1; ceil(); min 1 slot when mutationConcurrency >= 2; 0 slots at 1 | per instance |
| rate limits | off | optional per op: { requestLimit, requestPeriodMs, requestTimeoutMs } | per instance |
| hot table retention | 24h | per deployment | dispatcher config |
| claim batch size | 50..100 rows | — | dispatcher |
| create read-back delay | > attemptDeadlineMs of that instance/op | — | dispatcher |
| create retry after read-back miss | max 1 | — | dispatcher |

## Phase 1.5: test harness

Environment fact: Claude Code on the web has no Docker. Postgres runs as a local process installed from apt. Verified working in an equivalent sandbox: apt install postgresql (v16), initdb as the session user, pg_ctl on a Unix socket, SKIP LOCKED and range partitioning confirmed.

New files:
- `packages/core/test/harness/FakeConnector.ts` — builder returning a real ConnectorSpi over an in-memory target store (accounts keyed by uid, naming attribute indexed). Behavior emerges from state: create on a taken name throws ALREADY_EXISTS, delete of a missing uid throws UNKNOWN_UID, read-back finds applied accounts. Fault modes: `latency(ms)`, `failNext(code)`, `hangUntilAborted()`, `applyThenHang()` (applies the mutation, never resolves; the INDETERMINATE-then-read-back case). Flags mirror manifest capabilities: streaming search, poolable, idempotentDelta, equalitySearchOnName. Every call appends `{ op, args, abortHonored }` to a public call log.
- `packages/core/test/harness/MemoryOperationStore.ts` — in-memory implementation of the OperationStore interface (Phase 4). Used by dispatcher logic tests.
- `packages/core/test/contract/operation-store.contract.ts` — one shared suite exercised against MemoryOperationStore always and the Postgres store when DATABASE_URL is set. The two implementations cannot drift.
- `packages/core/test/harness/pg.ts` — `describeWithPg`: reads DATABASE_URL, pings, skips the suite when absent or unreachable. Plain `npm test` never requires a database.
- `packages/core/test/harness/clock.ts` — vitest fake-timer helpers for TTL eviction, backoff, read-back delay, token buckets. No test sleeps.
- `packages/core/test/harness/async.ts` — `deferred<T>()` and a two-party barrier for scripted interleavings (TOCTOU test: two acquires enter before either factory resolves, factory runs once).
- `scripts/test-pg.sh` — bootstrap: if no server answers, `apt-get update && apt-get install -y postgresql`, `initdb -D .pgdata -A trust`, `pg_ctl -D .pgdata -o "-p 5433 -k /tmp" start`, create db `gcf_test`, print `DATABASE_URL=postgres:///gcf_test?host=/tmp&port=5433`. Add `.pgdata/` to .gitignore. No sudo assumption; use the session user.
- `packages/core/test/load/soak.ts` — manual script, not a vitest suite: enqueue 50k mixed-priority ops against FakeConnectors, assert drain rate, per-lane ordering via call logs, interactive latency under batch flood. Run by hand at Phases 7 and 8.

Package scripts (core): `"test:pg": "bash ../../scripts/test-pg.sh && DATABASE_URL=... vitest run --dir test"` (script emits the URL; wire via env). CI: add a job with a `postgres:16` service container and DATABASE_URL set; the existing test job stays database-free.

Accept: `npm test` green with no database present; `bash scripts/test-pg.sh` then contract suite green against real Postgres in the CC web session; FakeConnector unit-tested for each fault mode.

## Phase 2: SPI error taxonomy

New file `packages/core/src/spi/errors.ts`. Export from `spi/index.ts`.

- `export type ConnectorErrorCode = "ALREADY_EXISTS" | "UNKNOWN_UID" | "CONNECTION_FAILED" | "INVALID_ATTRIBUTE" | "PERMISSION_DENIED" | "RATE_LIMIT_TARGET" | "UNKNOWN"`.
- `export class ConnectorError extends Error` with readonly `code: ConnectorErrorCode` and readonly `retryable: boolean`. Constructor `(code, message, opts?: { retryable?, cause? })`. Default retryable: true only for CONNECTION_FAILED and RATE_LIMIT_TARGET.
- Type guard `isConnectorError(e: unknown): e is ConnectorError`.
- JSDoc on the class: connectors SHOULD throw ConnectorError; the dispatcher maps UNKNOWN_UID and ALREADY_EXISTS per the resolution protocol; unclassified errors map to FAILED_CONFIRMED when the target answered, INDETERMINATE when the deadline expired.
- No other error subclasses. No error hierarchy.

Accept: build passes; new exports resolve from `@governance-connector-framework/core`.

## Phase 3: manifest capability flags + instance runtime config

Files: the loader manifest types + zod schema (find them under `packages/core/src/loader/`), and the instance-config type used by `initInstance`.

Manifest additions, all optional booleans defaulting false:
- `poolable` (stateful protocol; run through tarn pool)
- `idempotentDelta` (delta update ops safe to retry)
- `equalitySearchOnName` (supports EqualsFilter on the naming attribute; enables create read-back)

Instance runtime config additions (new optional `runtime` block on instance config), validated with zod at `initInstance` time:
- `attemptDeadlineMs`: number or per-op record `{ create?, update?, delete?, get?, search?, sync? }`; each value integer 1..120000; explicitly reject -1 and 0 with a message naming the ceiling.
- `mutationConcurrency`, `readConcurrency`: integers >= 1.
- `interactiveSliceFraction`: number in [0,1].
- `rateLimits`: optional per-op record of `{ requestLimit: number; requestPeriodMs: number; requestTimeoutMs?: number }`.
- Compute and expose resolved values with defaults from the constants table via a pure function `resolveRuntimeConfig(raw): ResolvedRuntimeConfig` with unit tests, including the slice floor rule.

Accept: build passes; tests cover: -1 rejected, ceiling enforced, slice floor at budgets 1, 2, 3, 10.

## Phase 4: operation table DDL + store module

New files: `packages/core/src/ops/schema.sql`, `packages/core/src/ops/OperationStore.ts`. New dependency: `pg` (+ `@types/pg` dev). The store takes a `pg.Pool` in its constructor; it never creates one. Give the dispatcher its own small pool in docs.

`schema.sql` (Postgres, Cloud SQL):
- `operations` table, partitioned by range on `created_at`, daily partitions:
  `id uuid pk default gen_random_uuid()`, `instance_id text not null`, `object_class text not null`, `op_type text not null check in (CREATE, UPDATE, DELETE)`, `priority text not null default 'batch' check in (interactive, batch)`, `status text not null default 'PENDING' check in (PENDING, RUNNING, SUCCEEDED, REJECTED_PRE_DISPATCH, FAILED_CONFIRMED, INDETERMINATE)`, `lane_key text not null`, `uid text null`, `name_attr_value text null`, `attrs jsonb null`, `result jsonb null` (holds Uid + ConnectorObject on success), `error_code text null`, `attempt_count int not null default 0`, `created_at timestamptz not null default now()`, `claimed_at timestamptz null`, `finalized_at timestamptz null`, `idempotency_key text not null`.
- Unique index on `(idempotency_key, created_at)` (partition key must be in unique indexes).
- Partial index `(instance_id, status) WHERE status = 'PENDING'`.
- Index `(instance_id, lane_key) WHERE status IN ('PENDING','RUNNING')` for lane serialization checks.
- `operations_history` table, not partitioned, slim: `id, instance_id, object_class, op_type, status, uid, error_code, created_at, finalized_at`. Uid survives retention forever.
- Comment block at top: partition drop is gated on zero non-terminal rows in the partition; retention default 24h.

`OperationStore.ts` methods, all parameterized SQL, no string interpolation:
- `enqueue(op): Promise<{ id }>` — insert PENDING; on idempotency-key conflict return the existing row id.
- `claimBatch(limit, activeLaneKeys, perInstanceAvailable): Promise<Row[]>` — one query: `SELECT ... FROM operations WHERE status='PENDING' AND lane_key NOT IN (active) ... ORDER BY priority = 'interactive' DESC, created_at ASC LIMIT $n FOR UPDATE SKIP LOCKED`, then `UPDATE ... SET status='RUNNING', claimed_at=now()`. Fair share across instances happens in the dispatcher by capping rows per instance per cycle, not in SQL.
- `finalize(id, outcome, result?, errorCode?)` — set terminal status, write slim row to history in the same transaction.
- `requeue(id)` — RUNNING back to PENDING, attempt_count + 1 (dispatcher retry path).
- `pendingCounts(instanceId): Promise<{ interactive: number; batch: number }>` — admission checks.
- `getStatus(id)` — status endpoint backing query.

Accept: build passes; contract suite (Phase 1.5) green against MemoryOperationStore and against local Postgres via `test:pg`; DDL loads clean; two concurrent claimers never claim the same row (SKIP LOCKED test).

## Phase 5: ConnectorManager (replaces direct registry use for the data path)

New file `packages/core/src/registry/ConnectorManager.ts`. Surgical: `ConnectorRegistry` keeps manifest/version bookkeeping; the manager owns instance lifecycle. Existing eager `initInstance`-at-boot path changes to registration-only (store config, do not construct the connector).

- `acquire(instanceId): Promise<Lease>` — get-or-create. The map stores `Promise<Instance>`, inserted before any await (kills the TOCTOU race). Failed init deletes the map entry before rethrowing.
- `Lease` = `{ facade: ConnectorFacade; release(): void }`. Refcount per instance. `release()` never disposes inline.
- Idle eviction: timer sweep; dispose only at refcount 0 and idleFor > TTL (default 15 min). Live-instance cap (default 200) with LRU eviction among refcount-0 instances.
- Facades constructed and cached inside the manager. Do not export raw SPI from the manager. Leave `registry.getSpi` in place but mark `@deprecated` — do not remove (websocket package may use it).
- Dispose calls connector `dispose()` if present; errors logged, never thrown.
- Unit tests: concurrent first acquire runs factory once; release-then-evict; eviction skipped at refcount > 0; cap eviction order.

Accept: build passes; tests above green; no change to websocket package behavior.

## Phase 6: facade rework

File: `packages/core/src/registry/ConnectorFacade.ts`. Three changes, nothing else.

1. Caching becomes opt-in. Remove the default entity cache and the prefix-scan invalidation entirely. If instance config sets `runtime.readCache: { ttlMs, max }`, construct a small per-facade cache for `get` only. No invalidation scans: TTL only. Schema result may stay cached (it is per-connector-version static data).
2. Deadline + abort propagation. Facade derives per-call timeout: `min(remaining deadline budget, resolved attemptDeadlineMs for the op)`. It creates an `AbortController`, passes `options.abortSignal` through to the connector, aborts on timeout, and maps the abort to an error carrying INDETERMINATE semantics for mutations (throw `ConnectorError("CONNECTION_FAILED", ..., { retryable: false })` is wrong here — introduce a dedicated internal `DeadlineExpiredError` in the facade module, the dispatcher maps it to INDETERMINATE).
3. Breaker limits from config. `CircuitBreaker` options come from resolved runtime config (mutation/read budgets as maxConcurrent per plane: two breakers per facade, one for mutations, one for reads). Remove the hard-coded defaults at the construction site only.

Streaming: search/sync must pass the caller's ResultsHandler through end-to-end when the connector declares `searchStreaming`. Delete the internal buffering (`out.push`) path for streaming connectors; keep the list-form path for list connectors.

Accept: build passes; tests: deadline aborts a hung fake connector at budget; handler `false` stops a streaming fake; no cache unless configured.

## Phase 7: dispatcher

New file `packages/core/src/ops/Dispatcher.ts`. Constructor takes `{ store, manager, config }`. Runs in-process; multiple replicas coordinate through SKIP LOCKED only — no leader election, no locks beyond the claim query.

Loop, every `claimIntervalMs` (default 25):
1. Compute per-instance available slots: mutation budget minus running, split by interactive slice (interactive may use all slots; batch capped at budget minus slice).
2. Token-bucket check for instances with rate limits; skip instances with empty buckets.
3. `claimBatch` with active lane keys excluded and per-instance caps; round-robin instance order across cycles (fair share).
4. Per row: `manager.acquire`, build OperationOptions (abortSignal, deadlineEpochMs = now + resolved attemptDeadlineMs, priority), dispatch by op_type, then finalize/requeue per the resolution protocol. Always `lease.release()` in finally.

Lane keys (set at enqueue in Phase 4 API): CREATE → `create:${objectClass}:${nameAttrValue}`; UPDATE/DELETE → `uid:${objectClass}:${uid}`.

Resolution protocol (CP-1, LOCKED):
- DELETE: on UNKNOWN_UID → SUCCEEDED. On retryable error or deadline → requeue with backoff (attempt cap 5, exponential from 1s, cap 60s). Else FAILED_CONFIRMED.
- UPDATE: replace-semantics ops retry on deadline/retryable. Delta ops retry only if manifest `idempotentDelta`; otherwise deadline → INDETERMINATE.
- CREATE success: persist Uid + ConnectorObject in `result`, SUCCEEDED.
- CREATE deadline: schedule read-back at `now + attemptDeadlineMs + 2s` (never earlier than deadline expiry): EqualsFilter on the naming attribute via the facade read path. Found → SUCCEEDED with discovered Uid. Miss → requeue once (attempt cap 1 for this path). Connector lacks `equalitySearchOnName` → INDETERMINATE immediately.
- CREATE ALREADY_EXISTS: FAILED_CONFIRMED (option a: the delete-recreate race resolves through the caller's retry; do not add a race classifier).
- REJECTED_PRE_DISPATCH is set only before dispatch: admission cap hit at enqueue time (Phase 4 API returns 429 + backlog depth), breaker open, invalid config.

Admission (enqueue path, exported function the API layer calls): per-instance per-class PENDING cap (defaults: batch 10000, interactive 1000, overridable); over cap → throw a typed `AdmissionRejectedError` carrying backlog depth. The API layer maps it to 429.

Accept: build passes; integration test with a fake connector + in-memory store stub covering: lane serialization, interactive bypass of a batch backlog, delete UNKNOWN_UID → SUCCEEDED, create deadline → read-back → SUCCEEDED with Uid, delta retry gate.

## Phase 8: pool wiring

Files: `packages/core/src/infra/Pool.ts` (exists), manager from Phase 5.

- Manifest `poolable: true` → manager constructs instances through tarn: `min` 0, `max` = mutationConcurrency + readConcurrency, `acquireTimeoutMillis` derived per call as `min(configured, remaining deadline budget)`, `idleTimeoutMillis` 60s, `validate` wired to connector `test()` when present.
- Non-poolable connectors: unchanged single instance; REST connectors document keep-alive agent usage in the connector template (doc change only, no framework code).
- Pool disposal wired into manager eviction and shutdown.

Accept: build passes; test: pooled fake connector sees N distinct SPI objects under N concurrent ops; dispose drains the pool.

## Phase 9: metrics

New file `packages/core/src/infra/Metrics.ts`. Interface first, console/no-op default, Prometheus left to the embedder — export a `MetricsSink` interface with `counter/gauge/histogram` and call sites; no client library dependency.

Instrument: backlog depth + oldest-pending age per instance (the two primary signals), claim cycle duration, outcome counts by type, attempt latency histogram per instance, breaker state transitions, event-loop lag (use `perf_hooks.monitorEventLoopDelay`), live instance count, pool in-use/idle.

Accept: build passes; dispatcher test asserts counters increment.

## Phase 10: docs

Update README on the branch: async contract (202 + operationId, status endpoint semantics, outcome taxonomy table), runtime config reference (constants table above), retention + partition-drop gate, GCS payload-audit export requirement for payload-audit deployments, connector author obligations (honor abortSignal, throw ConnectorError, declare capability flags, document expected write latency for slow targets).

Accept: README matches implemented behavior; no aspirational features documented.

## Phase 11: status model, read-back deferral (BUG-1), reaper (BUG-2), RFE-1

Authority: BUG_LOG.md entries BUG-1 (including the addendum), BUG-2, RFE-1. Read all three before writing code.

One migration, `packages/core/src/ops/migrations/002_status_and_optype.sql`, plus the same changes applied to `schema.sql` for fresh installs. The migration carries Phase 12's op_type constraint change too, so Phase 12 is code-only.

Schema:
- New status `AWAITING_READBACK` (non-terminal). New column `not_before timestamptz null`.
- Derived terminality: `terminal boolean GENERATED ALWAYS AS (status NOT IN ('PENDING','RUNNING','AWAITING_READBACK')) STORED`. Rewrite all four allow-list sites against it or against the non-terminal statuses via one definition: drop gate counts `NOT terminal`; claim index predicate becomes `WHERE NOT terminal` on `(instance_id, status, not_before)`; lane index predicate `WHERE NOT terminal`; status check constraint extended.
- op_type check extended with `ADD_VALUES`, `REMOVE_VALUES` (dispatch lands in Phase 12).

Store:
- `deferForReadback(id, notBefore)`: sets AWAITING_READBACK + not_before. Does NOT increment attempt_count (BUG-1 trap 1; same rule CP-3 recorded for backoff).
- `claimBatch` claims PENDING rows, plus AWAITING_READBACK rows with `not_before <= now()`. Claimed AWAITING_READBACK rows carry their prior status to the dispatcher.

Dispatcher:
- `resolveCreateAfterDeadline` no longer sleeps. On deadline: `deferForReadback(id, now + attemptDeadlineMs.create + readBackGraceMs)`, release slot, lease, and claim; lane stays excluded through the lane index (BUG-1: the lane hold is correct and must survive).
- A claimed AWAITING_READBACK row resumes at the read-back step, never re-issues the create (BUG-1 trap 2; the status is the marker).
- Reaper in the dispatcher loop under `pg_advisory_xact_lock`: rows RUNNING with `claimed_at < now() - reaperThresholdMs`. Threshold default 10 min, configurable; must exceed the instance deadline ceiling plus read-back grace (BUG-2: reclaiming live work makes two dispatchers run one mutation). Reaped CREATE -> `deferForReadback` (outcome unknown; blind retry is the duplicate-account path). Reaped UPDATE/DELETE -> PENDING without attempt_count increment. Reaper ignores AWAITING_READBACK rows before not_before.

Config (RFE-1): floor applies only when `interactiveSliceFraction > 0`; zero means zero slots. One-line change + test. CP-4 records the amendment.

Tests: slot released during read-back wait (other ops on the instance claimable, same-lane op not); resumed row performs search not create; reaper routes each op_type correctly and skips deferred read-backs; contract suite extended for deferForReadback and the widened claim; pg tier green; drop gate refuses a partition holding AWAITING_READBACK.

Close BUG-1, BUG-2, RFE-1 in BUG_LOG.md with fixing commits.

## Phase 12: delta operations (BUG-3, option A)

Decision: option A, ICF alignment (`UpdateAttributeValuesOp`). Recorded at CP-4.

- Enqueue API accepts op_type `ADD_VALUES` / `REMOVE_VALUES`: requires uid; attrs carry the values to add or remove. Lane key: uid-based, same as UPDATE/DELETE.
- Dispatcher arms call `facade.addAttributeValues` / `facade.removeAttributeValues` (already breaker- and deadline-wired).
- Retry gate: on deadline or retryable error, retry only when the manifest declares `idempotentDelta`; otherwise INDETERMINATE (reconciliation backstop). No read-back for deltas.
- Delete `isDeltaUpdate` and every `__DELTA__` reference (code, README, openapi). UPDATE is always replace.
- FakeConnector: stateful add/remove implementations plus a non-idempotent append mode to prove the gate.
- Tests: grant adds without clobbering existing values; delta timeout on a non-declaring connector -> INDETERMINATE with zero retries; declaring connector retries; replay against the non-idempotent fake demonstrates why the gate exists.

Close BUG-3. Update README and openapi. CP-4 after both phases: ratify bug-log conventions, RFE-1 amendment, BUG-3 option A, and the reaper threshold rule.
