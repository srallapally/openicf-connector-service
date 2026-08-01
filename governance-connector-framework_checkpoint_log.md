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
