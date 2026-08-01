# CPLOG governance-connector-framework
<!-- v:1 -->

---
## CP-1 | 2026-07-31T00:00:00Z
<!-- topic: local async provisioning architecture, full session -->

### DECIDED
- scope: local embedding only; remote WS connector service excluded — LOCKED
- caller: single trusted identity, governance provisioning service — LOCKED
- workload: ~3k ops/sec peak, 60/40 write/read, spiky; provision for drain rate not peak
- mutations: async, 202 + operationId, durable op table; get/search synchronous — LOCKED
- ICF semantics: single-object ops only, no bulk; query streams via ResultsHandler
- datastore: existing Cloud SQL schema, FOR UPDATE SKIP LOCKED claims — LOCKED
- table hygiene: batch claims 50-100 rows; partial index (instance_id,status) WHERE PENDING; daily partitions; slim history on finalize; fat payload audit → GCS
- retention: hot table 48-72h resolution window (default, tunable)
- sizing: 2-4 vCPU, 2 dispatcher replicas active-active day one; SKIP LOCKED distributes claims
- SPI contract: AbortSignal + deadline in OperationOptions — LOCKED
- deadline: single budget set at API edge, each layer derives wait from remainder
- outcome taxonomy: REJECTED_PRE_DISPATCH / FAILED_CONFIRMED / INDETERMINATE — LOCKED
- connector manager: lazy get-or-create, in-flight promise stored in map (kills TOCTOU), refcounted leases, idle-TTL evict at refcount 0, live-instance cap w/ LRU
- facades: constructed+cached inside manager; no raw SPI escape hatch
- pooling: tarn only for manifest-declared poolable (LDAP/SQL/SSH); REST gets keep-alive agent
- breaker: per-instance configurable limits; instant shed = correct admission semantics
- read plane: no default caching, opt-in per connector; handler streamed end-to-end, handler false ⇐ HTTP backpressure
- scheduler: priority hint in OperationOptions (interactive|batch, default batch) from caller provenance; fair-share claim across instance lanes; then created_at
- lane concurrency: reserved interactive slice per instance
- admission: per-instance per-class PENDING cap → 429 + backlog depth as flow control
- lanes: serialize per (instanceId, natural key); create keyed __NAME__, update/delete keyed Uid
- Uid lifecycle: target-minted on create, returned in result; update/delete carry Uid in payload
- __NAME__: always client-supplied; __UID__/__NAME__ declared per object type config → generic read-back — LOCKED
- create result: Uid (+ConnectorObject) persisted in terminal record; slim history keeps Uid permanently
- resolution/delete: retry; UnknownUid ⇒ SUCCEEDED
- resolution/update: retry (replace idempotent); delta ops retry only if manifest declares idempotent-delta
- resolution/create: delayed read-back EqualsFilter on __NAME__; found ⇒ SUCCEEDED+Uid; miss ⇒ max 1 retry; unsupported search ⇒ INDETERMINATE → recon backstop
- delete→recreate same-name race: accept transient AlreadyExists, create retry resolves [option a, recorded]
- manifest capability flags: poolable, idempotent-delta, equality-search-on-name
- constraint: no new k8s pods; sidecar container in existing pod is permitted escalation path
- process topology: in-process first; sidecar over localhost HTTP iff event-loop lag proves it; op table makes boundary deferrable
- build order: SPI contract → op table DDL + status endpoint → manager → dispatcher (lanes, fairness, read-back) → pool wiring → metrics — LOCKED

### REJECTED
- local WebSocket transport → solves firewall traversal, absent locally; adds correlation/timeout machinery, zero isolation in-process
- broker/queue (Pub/Sub etc.) for mutations → at-least-once redelivery vs non-idempotent create = duplicate accounts; reads become RPC-over-messaging; broker placement problem
- sync create/update/delete over queue → RPC over broker, worst of both
- Firestore op table → ~$3.5k/mo @500 mut/sec ($0.09/100k writes); no SKIP LOCKED, contended claim txns
- Memorystore → durability requirement fails; Spanner → cost floor unneeded
- priority derived from request shape → no bulk ops in ICF, recon vs helpdesk byte-identical
- pure fairness w/o priority → cannot distinguish recon vs helpdesk within one instance; superseded by trusted-caller hint
- serialize all mutations per instance → kills throughput (race option b)
- default entity read caching + scan invalidation → measured 2.45ms sync scan/create (loop saturates ~400 mut/sec/core); 315KB/facade empty (307MB @1k instances); 30s cross-pod stale read-after-write
- eager sequential boot of all instances → minutes boot, thundering herd on targets, memory for untouched apps

### OPEN
- per-attempt deadline default (N magnitude) [context: internal budget now, not caller promise]
- lane concurrency + drain-rate defaults per instance [context: target-system rate limits dictate]
- interactive slice fraction of lane concurrency
- retention window confirmation (48-72h assumed)
- recreate-after-delete frequency in governance flows [context: revisit race option a if common]
- event-loop lag threshold triggering sidecar split — DEFERRED [blocked_on: metrics in prod]

### STATE
- repo main@9136e57: builds clean; prior review blockers fixed (semver dep, JtiCache dup, per-facade cache, dup-id guard, breaker inflight, dispose wiring, GuardedString)
- core defects open: scan invalidation, cache prealloc, eager boot, pool unwired, breaker hardcoded, initInstance TOCTOU, no refcount/eviction, facade search+sync buffer streams (ICF violation), no metrics
- design: specification-ready
- SPI contract diff (spi/types.ts): not_started, next artifact
- op table DDL: not_started

---
## CP-2 | 2026-07-31T20:30:00Z
<!-- topic: open items 1-5 resolved -->

### DECIDED
- attempt deadline: per-instance per-op config in ms, default 3000, ceiling 120000, -1 rejected at config validation — LOCKED
- read-back delay: must exceed the attempt deadline [target may finish after abort]
- slow targets (Workday/SAP class): operator override required; connector docs must state expected write latency
- concurrency: two per-instance budgets, mutation default 10, read default 10, both overridable — LOCKED
- rate limits: optional per-op, IDM shape (request limit, period, timeout), token bucket checked before claim, off by default
- interactive slice: per-instance fraction of mutation budget, default 0.2; ceil(), min 1 slot at budget ≥2, none at budget 1
- slice asymmetry: interactive may use all slots, batch capped at budget minus slice
- retention: hot table default 24h, per-deployment config; partition drop gated on zero non-terminal rows — LOCKED
- GCS payload audit export: required for payload-audit deployments [24h window makes it the only forensic source]
- lifecycle reality: disable-as-delete common, delete-then-recreate rare → race option a confirmed (see CP-1)
- disable/enable = update on Uid → already covered by idempotent-replace retry, single lane, no race

### REJECTED
- -1 unlimited timeout parity w/ IDM configs → hung target pins lane slots for minutes; explicit ceiling instead
- shared read+write concurrency budget → slow streaming search starves mutation slots invisibly
- fixed interactive slot count → breaks small budget overrides; fraction + floor rule instead
- AlreadyExists race-classifier query on create failure → deferred as unneeded; remedy on record if recreate clusters appear in failure metrics

### OPEN
- event-loop lag threshold for sidecar split — DEFERRED [blocked_on: prod metrics] (carried from CP-1)

### STATE
- CP-1 open items 1-5: resolved
- SPI contract diff (spi/types.ts @9136e57): not_started, next artifact
- op table DDL: not_started

---
## CP-3 | 2026-08-01T17:44:13Z
<!-- topic: phases 1-10 implemented, reviewed, merged -->

### DECIDED
- registry split: registerInstance records, materializeInstance builds; in-flight promise shared — LOCKED
- initInstance stays eager (register+materialize) [websocket reads .impl off return]
- runtime config validation hand-rolled; zod is a websocket dep, not core
- op table PK (id, created_at) [Postgres: partition key required in every unique key] — LOCKED
- idempotent enqueue via pg_advisory_xact_lock(sha256(key)) + lookup, not a unique index — LOCKED
- claim SQL: collapse lanes to one row BEFORE per-instance ranking
- backoff enforced by excluding the lane from claim, never by bouncing the row
- delta update marked `__DELTA__: true` on payload; absent ⇒ treated as replace
- DeadlineExpiredError distinct from ConnectorError; own-timer expiry overrides connector AbortError — LOCKED
- facade search: caller handler ⇒ passthrough, no buffering; no handler ⇒ list form (buffering = caller's choice)
- two breakers per facade, maxConcurrent from mutation/read budgets
- pooledSpi: proxy over tarn; probe resource for shape; flags copied (searchStreaming is data)
- pool acquire timeout = min(configured, remaining deadline); aborts the tarn request, not just abandons
- capabilities keyed by type@version [describe the build, not the instance]
- MetricsSink interface, noop default, no client library — LOCKED
- backlog depth sampled 1-in-40 cycles, before the claim
- event-loop lag: NaN window ⇒ emit 0
- test harness: FakeConnector + MemoryOperationStore + one shared contract suite
- scripts/test-pg.sh runs server-side as postgres user [initdb refuses root]
- CI: postgres:16 job added; existing job stays database-free and is the gate
- merge method rebase [repo blocks merge commits; squash would collapse 11 phase commits]
- design authority docs committed to repo root

### REJECTED
- squash merge → collapses one-phase-per-commit history
- zod added to core → violates no-new-runtime-deps-except-pg
- initInstance registration-only by default → breaks websocket .impl reads, same phase forbids touching it
- unique (idempotency_key, created_at) as dedup → timestamps differ, never collides, enforces nothing
- rank before lane collapse → same-lane backlog burns instance cap on discarded rows
- requeue deferred rows during backoff → requeue increments attempt_count, exhausts retry budget without attempting
- manager clock passed into facade → desyncs from the setTimeout the deadline uses
- vitest import in pg connection helpers → throws under plain tsx (soak script)

### OPEN
- interactive slice floor reserves 1 slot at fraction 0 [context: literal CP-2 rule; ceil() already guarantees >=1 for any positive fraction, so floor only bites at exactly 0]
- stale-RUNNING reaper absent [context: dispatcher death pins rows RUNNING, blocks partition drop past retention]
- `__DELTA__` marker unratified [context: plan required the gate, never named the marker]
- event-loop lag threshold for sidecar split — DEFERRED [blocked_on: prod metrics] (carried from CP-1, CP-2)

### STATE
- phases 1-10 + 1.5: complete [supersedes CP-1: SPI contract diff, op table DDL; supersedes CP-2: same]
- CP-1 core defects: all closed [supersedes CP-1: scan invalidation, cache prealloc, eager boot, pool unwired, breaker hardcoded, initInstance TOCTOU, refcount/eviction, facade stream buffering, metrics]
- merged to main@491d2ac via rebase (PR #39, 12 commits)
- tests: core 333 + 33 pg-only, websocket 242 unchanged; both CI jobs green
- verified on PostgreSQL 16: DDL, drop gate, 3-way concurrent claim, 8-way idempotent enqueue
- soak vs real dispatcher: 4k ops, 0 lane violations, interactive p50 64ms vs batch 151ms
- defects found+fixed in own phases: lane double-claim, non-uuid id 500, backoff attempt inflation, lag NaN
- feature/async-provisioning @ a7f027e, restarted on merged main; local main untouched

---
## CP-4 | 2026-08-01T18:38:03Z
<!-- topic: phases 11-12, bug remediation ratified -->

### DECIDED
- bug-log conventions ratified: BUG-n / RFE-n, ids never reused, severity by consequence not effort — LOCKED
- BUG_LOG.md is the third design record: plan says intended, CPLOG says decided, bug log says wrong-with-built
- interactive slice: fraction 0 means zero slots [amends CP-2: "min 1 slot at budget >=2"] — LOCKED
- slice floor applies to positive fractions only [ceil() already guarantees >=1, so 0 was the only input it changed]
- terminality derived in SQL: generated `terminal` column, four allow-list sites collapsed to one definition — LOCKED
- AWAITING_READBACK: non-terminal status + not_before column; deferral replaces the inline read-back sleep
- deferred row holds its lane, not its slot/lease/claim [blocked_lanes makes lane serialization durable across restart]
- deferForReadback does not increment attempt_count [read-back allows one retry; the wait must not spend it]
- priorStatus on the claimed row marks a resume; a resumed create searches, never re-issues
- reaper: RUNNING rows older than reaperThresholdMs, default 10 min, configurable — LOCKED
- reaper threshold rule: must exceed instance deadline ceiling + read-back grace [reclaiming live work = two dispatchers, one mutation] — LOCKED
- reaper routing: CREATE -> read-back (outcome unknown), UPDATE/DELETE -> PENDING (idempotent); neither increments attempt_count
- reaper serializes replicas on pg_try_advisory_xact_lock; loser skips the pass
- BUG-3 resolved as option A: ICF alignment via UpdateAttributeValuesOp — LOCKED
- delta ops are op types ADD_VALUES / REMOVE_VALUES, uid-required, uid lane [same lane as UPDATE/DELETE so grant and revoke cannot overlap]
- delta retry gate: retry only when manifest declares idempotentDelta, else INDETERMINATE; no read-back for deltas — LOCKED
- UPDATE is always full replace, idempotent by construction, retries freely
- pendingCounts counts AWAITING_READBACK as backlog [unresolved work the caller waits on]
- migration numbering starts at 002; schema.sql is effectively 001, applied whole and idempotent; no runner in-package
- openapi.yaml carries vocabulary schemas only [framework supplies machinery, not an HTTP surface]

### REJECTED
- `__DELTA__` marker on an ordinary UPDATE → the flag gated retry but never changed what executed, so the gate guarded a path the dispatcher could not reach; a delta is a different operation, not a replace wearing a marker
- BUG-3 option B (declare deltas out of scope) → discards a working ICF-aligned surface already wired to breaker and deadline, to avoid four lines of dispatch
- RFE-1 option 1 (reject fraction 0 at validation) → 0 has an obvious meaning; honouring it beats erroring on it
- adding AWAITING_READBACK to four hand-written allow-lists → drop gate omission fails silently toward data loss; derive instead
- second index alongside the pending index for deferred rows → two overlapping partial indexes on the hot path cost a write per transition for no extra coverage
- read-back for deltas → no naming attribute to search on, no existence question to ask
- in-memory lane hold for the deferral → the deferred row outlives the cycle that made it; hold must be durable

### OPEN
- event-loop lag threshold for sidecar split — DEFERRED [blocked_on: prod metrics] (carried from CP-1, CP-2, CP-3)
- soak latency measured from enqueue, so a slow enqueue phase compresses priority separation [context: pg run reads 1.5x where memory reads 16x; instrument, not framework]
- MemoryOperationStore.claimBatch is O(n) per cycle [context: test double only; drops 17.8k/s at 5k to 2.7k/s at 50k; not a framework ceiling]

### STATE
- phases 11-12: complete; BUG-1, BUG-2, BUG-3, RFE-1 all FIXED, bug log empty of open entries
- tests: 428 with Postgres, 377 + 51 skipped without; websocket 242 unchanged
- migration 002 verified against a seeded pre-migration database: rows preserved, terminal derived, drop gate refuses a partition holding AWAITING_READBACK
- soak baseline recorded in soak.ts header: 50k memory 2,653/s, interactive p50 781ms vs batch 12,388ms, zero lane violations on both stores
- feature/async-provisioning carries phases 11-12; main last merged at 491d2ac (phases 1-10)

---
## CP-5 | 2026-08-01T19:06:39Z
<!-- topic: F13 extraction, framework/service boundary -->

### DECIDED
- boundary: framework executes one connector operation; the provisioning service owns the claim loop — LOCKED
- split rule: what the facade needs to execute one operation stays; what only the claim loop needs moves — LOCKED
- three-repo end state: governance-connector-framework (execution), provisioning service (queue/dispatch/routes), external-connectors (bundles)
- framework keeps: SPI, loader, registry, manager, facade, infra, capability flags, ConnectorError
- framework loses: src/ops entirely (OperationStore, Dispatcher, admission, schema.sql, migrations)
- OperationOptions keeps abortSignal, deadlineEpochMs, priority [ICF options bag is extensible; facade enforces the deadline for any caller; priority is a hint anyone may set]
- OperationOutcome / OperationStatus / OperationPendingStatus leave [they describe a durable row's lifecycle, which only the claim loop has]
- runtime config splits: core keeps attemptDeadlineMs, mutationConcurrency, readConcurrency, readCache; service takes interactiveSliceFraction and per-op rateLimits
- removed settings are rejected by name at validation, not silently ignored [an instance config still carrying them must say so]
- testing subpath `@governance-connector-framework/core/testing` ships FakeConnector, async, clock [ICF test-common precedent; connector authors need a credible target]
- vitest becomes an optional peerDependency [only the clock helper needs it; nothing in the main entry imports it]
- pg dependency removed from core [OperationStore was its only consumer]
- metric names split with the code: breaker, live instances, pool, event-loop lag stay; backlog/claim/outcome/attempt/reaped leave
- CI postgres job removed from the framework [nothing left here needs a database]
- bug log entries stay as history, marked component-moved; BUG-4 travels to the service as its first open entry

### REJECTED
- keeping OperationOutcome in core "because connectors might want it" → a connector returns or throws; it never reaches a terminal status, and keeping the taxonomy would make the type surface imply a queue the package does not own
- keeping MemoryOperationStore / contract suite / pg harness / soak in core → they test the claim loop, which is leaving; the contract suite is meaningless without both store implementations
- shipping FakeConnector from the main entry → would put vitest in the import graph of every production consumer
- leaving interactiveSliceFraction in core "since the facade reads runtime config" → the facade never consults it; see BUG-4, nothing consults it at all yet

### OPEN
- BUG-4: interactive slice computed but never enforced — MOVED to the service, still open [decided at CP-5 to fix where the dispatcher lands]
- event-loop lag threshold for sidecar split — DEFERRED [blocked_on: prod metrics] (carried from CP-1..CP-4)
- provisioning service repo does not yet exist; P0-P8 blocked on it

### STATE
- F13 complete: core 220 tests green, websocket 242 unchanged, both packages build
- core dependencies now lru-cache, semver, tarn; no pg, no database tier, no postgres CI job
- acceptance grep clean: no OperationStore/Dispatcher/OperationOutcome outside a signpost comment in spi/types.ts
- framework branch feature/async-provisioning; main last merged at 491d2ac (phases 1-10, still carrying ops)
- extraction source for the service: the commit immediately before this one (phases 11-12 complete, ops intact)

---
## CP-6 | 2026-08-01T19:11:00Z
<!-- topic: post-extraction issue status roll-up -->

### DECIDED
- issue disposition on a component move: entries fixed before the move stay as history in the origin repo; open entries travel and are re-filed where the code lands — LOCKED
- BUG-4 is the provisioning service's first bug-log entry, carried from here
- extraction reference is a commit SHA, not a tag [remote rejects tag ref pushes]
- P1 copies ops from af55795; the core git dependency pins e633763 [different commits by design: the last commit holding ops, and the first without it]
- the framework's bug log stays in the framework [it records what was wrong with what was built here, and half those entries describe code that has left]

### REJECTED
- git tag `extraction-source-ops` as the durable extraction pointer → the remote accepts branch pushes but hangs up on tag refs; the tag exists locally only, so the SHA is recorded in prose instead
- re-filing BUG-1/2/3 and RFE-1 in the service → all four were fixed before the move and their fixes travelled with the code; re-filing would imply open work

### OPEN
- BUG-4: reserved interactive slice computed but never enforced [context: `interactiveSlots`/`batchSlots` have no consumer; `computeAvailability` offers the whole mutation budget, so batch is never capped at budget minus slice; CP-1 and CP-2 both LOCK the asymmetry] — MOVED, open in the service
- event-loop lag threshold for sidecar split — DEFERRED [blocked_on: prod metrics] (carried from CP-1..CP-5)
- soak latency measured from enqueue, compressing priority separation on slow-enqueue runs [context: instrument, not framework] (carried from CP-4)
- MemoryOperationStore.claimBatch O(n) per cycle [context: test double; left with the ops code, so this is the service's now] (carried from CP-4)
- provisioning service repo does not exist; P0-P8 blocked on it (carried from CP-5)

### STATE
- issue roll-up, all five raised this cycle:
  - BUG-1 read-back sleeps inline holding slot+lease — FIXED 9d3a977 (Phase 11)
  - BUG-2 rows stranded RUNNING by a dead dispatcher — FIXED 9d3a977 (Phase 11)
  - BUG-3 delta updates unreachable, gate guards nothing — FIXED e223fe5 (Phase 12)
  - RFE-1 slice floor reserves a slot at fraction 0 — FIXED 9d3a977 (Phase 11); no runtime effect, see BUG-4
  - BUG-4 slice computed but never enforced — OPEN, MOVED at e633763
- framework bug log has no open entries that describe framework code
- F13 complete at e633763: core 222 tests, websocket 242 unchanged, both build
- core dependencies lru-cache, semver, tarn; vitest optional peer for the /testing subpath
- no database tier in the framework: pg dependency, pg harness, contract suite, and postgres CI job all left
- branch feature/async-provisioning @ e633763; origin/main @ 491d2ac (phases 1-10, still carrying ops); local main untouched at 9136e57
- unmerged on the branch: phases 11-12, the three design records, and the extraction
