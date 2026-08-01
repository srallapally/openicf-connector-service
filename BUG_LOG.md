# Bug log — governance-connector-framework

Tracking for defects and enhancement requests found outside the normal review
cycle. Append-only in spirit: entries are edited to change `Status` and to add
resolution notes, but the original report is not rewritten.

Companion to the design record. `CLAUDE_CODE_PLAN.md` says what was planned and
`governance-connector-framework_checkpoint_log.md` says what was decided; this
file says what is wrong with what was built.

## Conventions

**IDs** — `BUG-n` for defects, `RFE-n` for enhancements. Numbers are never
reused, including for entries that are closed as invalid.

**Status** — `OPEN` · `IN PROGRESS` · `FIXED` · `WONTFIX` · `INVALID`.
A `FIXED` entry names the commit that fixed it.

**Severity**

| Level | Meaning |
|---|---|
| `critical` | Data loss, corruption, or a wrong provisioning outcome. Duplicate accounts belong here. |
| `high` | Correctness broken under conditions that occur in normal operation. |
| `medium` | Correct but degrades under load or misconfiguration; no wrong outcome. |
| `low` | Cosmetic, or only reachable through operator error that is already reported. |

Severity describes consequence, not effort.

---

## Summary

| ID | Sev | Status | Component | Title |
|---|---|---|---|---|
| [BUG-1](#bug-1) | medium | FIXED | `ops/Dispatcher` | Create read-back sleeps inline, holding the lease and mutation slot |
| [BUG-2](#bug-2) | high | FIXED | `ops/*` | Rows left `RUNNING` by a dead dispatcher are never recovered |
| [BUG-3](#bug-3) | medium | OPEN | `ops/*` | Delta updates cannot be enqueued; the `idempotentDelta` gate guards an unreachable path |
| [RFE-1](#rfe-1) | low | FIXED | `config/runtime` | Interactive slice floor reserves a slot even at fraction 0 |

---

<a id="bug-1"></a>
## BUG-1 — Create read-back sleeps inline, holding the lease and mutation slot

| | |
|---|---|
| **Severity** | medium |
| **Status** | FIXED in Phase 11 |
| **Component** | `packages/core/src/ops/Dispatcher.ts` |
| **Reported** | 2026-08-01 |
| **Affects** | `main@491d2ac` (Phase 7 onward) |
| **Site** | `resolveCreateAfterDeadline`, the `await this.sleep(...)` before the read-back |

### Symptom

After a create times out, the dispatcher waits
`attemptDeadlineMs.create + readBackGraceMs` before reading the object back —
and does so with an inline `await`, inside `execute()`. For the whole of that
wait the operation still holds:

- its **mutation slot**, counted in `running` and subtracted from the
  instance's free budget by `computeAvailability`
- its **lane**, in `activeLanes` and therefore excluded from the claim query
- its **connector lease**, whose refcount blocks idle eviction

Nothing is executing during the wait. The resources are held purely to keep the
in-memory continuation alive.

### Impact

Negligible at the 3 s default: about 5 s of held slot per timed-out create.

It becomes material with the slow-target override CP-2 contemplates for the
Workday/SAP class. At `attemptDeadlineMs.create = 60000` a single timed-out
create occupies a slot for roughly two minutes — about 60 s burning the attempt,
then about 62 s sleeping.

The failure mode is the objectionable part: a degraded target produces more
timeouts, and each timeout removes drain capacity for the instance that is
already struggling. Throughput falls fastest exactly when the target is worst,
which is backwards. With `mutationConcurrency` of 10, ten concurrent timed-out
creates stall the instance completely for the duration.

The lane hold is correct and must be preserved — a second create on the same
name must not run while the first is unresolved. Only the slot and lease are
being held for no reason.

### Proposed fix

Requeue with a not-before timestamp and let the claim query enforce the wait,
which is the pattern the retry backoff already uses (`laneDeferredUntil`,
consulted by `excludedLanes()`). The operation returns to `PENDING`, its slot
and lease are released immediately, and it is not reclaimed until the delay
elapses. The lane stays excluded throughout, so the serialization guarantee is
unchanged.

Two things to get right:

1. **`attempt_count` must not be inflated.** `requeue()` increments it, and the
   read-back path is capped at exactly one retry, so a deferral that counted as
   an attempt would consume that budget without a read-back ever running. This
   is the same trap already fixed once for backoff (see CP-3, REJECTED). Either
   add a store method that requeues without incrementing, or carry the pending
   read-back as its own state rather than as a plain requeue.
2. **The reclaim must know it is resuming a read-back**, not starting a fresh
   create attempt — otherwise it re-issues the create it was trying to avoid
   duplicating. Needs an explicit marker on the row.

The second point makes this larger than moving one `await`: it wants a
representable "awaiting read-back" state, which the current three-column status
model does not have.

### Addendum — blast radius of a new non-terminal status

Adding a status such as `AWAITING_READBACK` is not additive. Three consumers
currently assume the status set is closed, and each enumerates its members by
allow-list rather than deriving them:

1. **The partition drop gate** — `drop_operations_partition` counts
   `status IN ('PENDING', 'RUNNING')` (`schema.sql:185`). A new non-terminal
   status is not in that list, so a partition holding a deferred read-back
   counts as fully terminal and becomes droppable. The row is destroyed, and
   with it the answer a caller was promised. This is the dangerous one: it
   fails silently, in the direction of data loss, and the gate that exists to
   prevent exactly this is what performs the deletion.

2. **The partial claim index** — `operations_pending_idx` covers
   `WHERE status = 'PENDING'` (`schema.sql:94-96`). Reclaiming read-back rows
   means either widening that predicate or adding a second index. The choice is
   not free: widening enlarges the hot index that every claim cycle scans, while
   a second index adds a write on every status transition. Either way it shows
   up in claim latency, which is the loop's tightest path.

3. **The reaper** (BUG-2, once it exists) must recognise the state. A row
   deferred for read-back looks abandoned by wall-clock age, so a reaper that
   only understands `RUNNING` either ignores it — leaving it strandable — or a
   naive age-based reaper reclaims it mid-wait and re-issues the create.

A fourth site shares the same pattern and is easy to miss:

4. **The lane index** — `operations_lane_idx` is predicated on
   `status IN ('PENDING', 'RUNNING')` (`schema.sql:102`). A deferred read-back
   row would fall out of the index that answers "which lanes are busy for this
   instance", so lane-serialization checks would stop seeing it.

The `operations_status_check` constraint (`schema.sql:80-88`) is a hard
prerequisite — it rejects any value not in the list — but it is the benign one,
because it fails loudly at insert rather than quietly at drop time.

The root cause is that **"non-terminal" is written out three times in SQL and
derived nowhere**. The TypeScript side does derive it: `OperationStatus` is
`"PENDING" | "RUNNING" | OperationOutcome`, so terminal is exactly "is an
`OperationOutcome`". The database has no such relationship. Worth fixing that
asymmetry as part of this work — a `terminal boolean GENERATED ALWAYS AS
(status = ANY(...))` column, or a predicate function the three sites share — so
the next status added cannot silently miss a site.

### Notes

Deliberately not fixed on report. The right shape touches the store contract and
the status model, so it warrants its own phase rather than a patch. The addendum
above is the argument for that: this is a schema migration with a data-loss
failure mode, not an edit to one `await`.

---

<a id="bug-2"></a>
## BUG-2 — Rows left `RUNNING` by a dead dispatcher are never recovered

| | |
|---|---|
| **Severity** | high |
| **Status** | FIXED in Phase 11 |
| **Component** | `packages/core/src/ops/` (`Dispatcher`, `OperationStore`, `schema.sql`) |
| **Reported** | 2026-08-01 |
| **Affects** | `main@491d2ac` (Phase 7 onward) |

### Symptom

`claimBatch` sets `status = 'RUNNING'` and stamps `claimed_at`. Nothing ever
reads `claimed_at` again — it is written on claim and nulled on requeue, and no
query anywhere selects on it. There is no reaper.

A dispatcher that dies between claiming a row and finalizing it — SIGKILL, OOM,
pod eviction, node loss — leaves that row `RUNNING` permanently. The other
replica cannot take it: the claim query selects `status = 'PENDING'`, so the row
is invisible to every future cycle.

`Dispatcher.ts`'s own header comment asserts that "a dispatcher that dies
mid-cycle loses only the rows it had claimed." That is true, and it is the
problem: those rows are lost with no mechanism to find them again.

### Impact

Three consequences, worsening in that order.

1. **The operation never resolves.** A caller polling `getStatus` sees `RUNNING`
   forever. There is no timeout on the caller's side either, because the
   framework's whole contract is that an operation reaches a terminal state.

2. **The lane is not blocked, but the object is in limbo.** The lane exclusion
   is in-memory (`activeLanes`), so it dies with the process. A subsequent
   operation on the same object can proceed while the abandoned row still claims
   to be running — the durable record and reality disagree.

3. **Retention stops working.** `drop_operations_partition` refuses any
   partition holding a non-terminal row, which is correct and deliberate. One
   abandoned row pins its day's partition open indefinitely. The 24h window
   silently becomes unbounded, and because the gate returns `false` rather than
   raising, the failure is quiet — a `NOTICE` in a log nobody reads.

Consequence 3 is what makes this `high` rather than `medium`: a single crash
during a busy hour eventually turns into a storage problem, and the mechanism
designed to make retention safe is exactly what converts it into a leak.

### Proposed fix

A reaper that returns rows whose `claimed_at` is older than a threshold to
`PENDING`. The threshold must exceed the largest possible attempt — the
instance's `attemptDeadlineMs` ceiling plus the read-back delay — or it will
reclaim work that is still legitimately running, and two dispatchers will
execute the same mutation concurrently. That is a worse bug than this one, so
the threshold wants to be generous and configurable rather than clever.

Recovery is a requeue, so the resolution protocol already covers what happens
next: a reclaimed create is not blind-retried, it goes through the read-back
path, which is the correct treatment for an attempt whose outcome is unknown.

Note the interaction with BUG-1: a fix there that introduces an "awaiting
read-back" state must make those rows reapable too, or it adds a second way to
strand an operation. The reaper must also distinguish the two — a row waiting
out its read-back delay looks abandoned by wall-clock age, and reclaiming it
mid-wait re-issues the create that BUG-1's fix exists to avoid duplicating. See
the addendum on BUG-1 for the full set of sites a new non-terminal status
touches; this reaper is one of them.

### Notes

Never specified. Not in `CLAUDE_CODE_PLAN.md`, not in CP-1 or CP-2, so it was
not implemented and not omitted in error — it is a gap in the design, surfaced
during implementation review and recorded in CP-3 OPEN.

---

<a id="bug-3"></a>
## BUG-3 — Delta updates cannot be enqueued; the `idempotentDelta` gate guards an unreachable path

| | |
|---|---|
| **Severity** | medium |
| **Status** | OPEN |
| **Component** | `packages/core/src/ops/` (`schema.sql`, `Dispatcher`) |
| **Reported** | 2026-08-01 |
| **Affects** | `main@491d2ac` (Phase 7 onward) |

### Symptom

CP-1 LOCKs: *"resolution/update: retry (replace idempotent); delta ops retry
only if manifest declares idempotent-delta."* Only the second half of that is
implemented, and it guards a path that cannot be reached.

- `op_type` is constrained to `CREATE`, `UPDATE`, `DELETE`. There is no
  representation for a delta operation.
- `attemptUpdate` always calls `facade.update()`, which is replace semantics.
- `facade.addAttributeValues` and `facade.removeAttributeValues` exist and are
  wired to the breaker and the deadline, but the dispatcher never calls either.
  They are unreachable from the async path.
- `isDeltaUpdate` reads `attrs.__DELTA__`, and that flag changes **only whether
  the operation is retried**. It does not change what is executed.

So an operation marked `__DELTA__: true` is executed as a full replace and then
declines to retry itself on the grounds that it might be a delta.

### Impact

No wrong outcome today, which is why this is `medium` and not `high`: a delta
cannot be enqueued at all, so nothing is being corrupted. What exists is a
safety gate wired to an operation the system cannot perform.

The risks are forward-looking and both are quiet:

1. **The gate reads as satisfied.** Anyone auditing against CP-1 finds
   `idempotentDelta` honoured in code and concludes deltas are handled. They are
   not — they are absent.
2. **`__DELTA__` is a marker this implementation invented.** It appears in the
   README, but no checkpoint decided it. A caller that sets it expecting delta
   semantics gets a replace, which for entitlement attributes means the
   difference between "add this group" and "these are now the only groups" —
   silent, and a plausible way to strip a user's access.

### Proposed fix

Decide first, then implement — this needs a checkpoint entry, not just a patch.
The shape of the decision:

- **Represent deltas properly**: extend `op_type` to include something like
  `ADD_VALUES` / `REMOVE_VALUES`, dispatch them to the corresponding facade
  methods, and let `idempotentDelta` gate retry for exactly those. This makes
  the CP-1 item true, and retires `__DELTA__`.
- **Or declare deltas out of scope** for the async path, remove `isDeltaUpdate`
  and the `__DELTA__` marker, drop the `idempotentDelta` manifest flag, and
  record the exclusion. Callers needing deltas would read-modify-write through a
  replace, which is idempotent and already supported.

Either is defensible. What should not persist is the current state, where the
flag implies a capability that does not exist.

Until it is resolved, `__DELTA__: true` is worth documenting as
"retry-suppression hint" rather than "delta operation", which is what it
actually does.

### Notes

Surfaced while filing RFE-1; recorded in CP-3 OPEN as "`__DELTA__` marker
unratified", which understated it. The marker is not merely unratified — the
operation it names cannot be enqueued.

---

<a id="rfe-1"></a>
## RFE-1 — Interactive slice floor reserves a slot even at fraction 0

| | |
|---|---|
| **Severity** | low |
| **Status** | FIXED in Phase 11 (option 2: `0` honoured as opt-out) |
| **Component** | `packages/core/src/config/runtime.ts` (`computeInteractiveSlots`) |
| **Reported** | 2026-08-01 |
| **Affects** | `main@491d2ac` (Phase 3 onward) |

### Symptom

`computeInteractiveSlots` implements the CP-2 rule literally:

```
budget <= 1        -> 0 slots
otherwise          -> min(budget, max(1, ceil(budget * fraction)))
```

Because `ceil()` already returns at least 1 for any positive fraction, the
`max(1, ...)` floor changes the result in exactly one case: `fraction === 0`.
An operator who sets `interactiveSliceFraction: 0` to mean "no reservation"
gets one reserved slot anyway, on any instance with a mutation budget of 2 or
more.

### Impact

Small and bounded — one slot out of the instance's mutation budget. It matters
only where the budget is small enough for one slot to be a large fraction of it,
and where the operator deliberately wanted batch work to have everything.

The real cost is that a documented, in-range configuration value silently does
not do what it says. `0` is accepted by validation, is inside the documented
`0..1` range, and is then ignored.

### The decision

CP-2 says *"min 1 slot at budget ≥2"* without qualification, so the current
behaviour is the faithful reading, and the floor arguably encodes a real intent:
interactive work should never be starvable while lanes are contended.

Two coherent resolutions:

1. **Keep the floor, reject the input.** If the reservation is genuinely
   non-negotiable, `interactiveSliceFraction: 0` is a contradiction and should
   fail validation with a message saying so, rather than being accepted and
   overridden.
2. **Honour 0 as opt-out.** Treat `0` as "no reserved slice" and keep the floor
   for every positive fraction, which is where it was aimed anyway — stopping a
   small fraction against a small budget from rounding down to nothing.

Option 2 is the smaller surprise and matches what an operator typing `0` means.
Option 1 is more defensible if the reservation is a safety property rather than
a tuning knob. Either way, a value should not be accepted and then disregarded.

Whichever is chosen wants a CP entry, since it either amends or confirms a CP-2
line.


---

## Resolutions

### BUG-1 — FIXED (Phase 11)

`resolveCreateAfterDeadline` no longer sleeps. A timed-out create is parked as
`AWAITING_READBACK` with a `not_before` timestamp, releasing its mutation slot,
its connector lease, and its claim. The claim query reclaims it once due and
marks it as a resume, so it searches instead of re-issuing the create.

Both traps named in the report were addressed:

- `deferForReadback` does not increment `attempt_count`, so the wait does not
  spend the single retry the read-back path allows.
- `priorStatus` on the claimed row is the marker that distinguishes a resume
  from a fresh attempt, so the create is never re-issued.

The lane hold survives, as required: `blocked_lanes` in the claim query treats
a not-yet-due `AWAITING_READBACK` row as occupying its lane, which also makes
lane serialization durable across a restart rather than living only in the
dispatcher's memory.

The addendum's four sites were closed by deriving terminality once, in a
`terminal boolean GENERATED ALWAYS AS (...) STORED` column. The drop gate, the
claimable index, and the lane index are all predicated on it; the status check
constraint is the only remaining enumeration, and it fails loudly at insert.

Verified: a deferred create releases its slot while an unrelated operation on
the same instance proceeds; a second create on the same lane is refused for the
duration; a resumed row performs one search and zero creates; and against
PostgreSQL 16 the drop gate refuses a partition holding a deferred read-back.

### BUG-2 — FIXED (Phase 11)

`OperationStore.reapStale` returns rows claimed longer ago than a configurable
threshold (default 10 minutes) to the backlog, and the dispatcher runs a pass
on its own slow cadence.

Routing follows the resolution protocol: an abandoned create's outcome is
unknown, so it is deferred for read-back rather than re-issued; update and
delete are idempotent and go straight to `PENDING`. Neither increments
`attempt_count` — the process died, which is not the operation's fault.

The interaction flagged on this entry is handled: the reaper only considers
`RUNNING` rows, so a row waiting out its read-back is not mistaken for an
abandoned one and reclaimed mid-wait.

Concurrent replicas serialize on a transaction-scoped advisory lock; a replica
that cannot take it skips the pass rather than double-reaping. Verified with
three concurrent reapers over six stranded rows: six recovered in total, none
twice, all with `attempt_count` still zero.

### RFE-1 — FIXED (Phase 11), option 2

`interactiveSliceFraction: 0` now yields zero reserved slots. The floor still
applies to every positive fraction, which is where it was aimed: stopping a
small fraction against a small budget from rounding down to nothing.

Option 2 over option 1 because a value that is documented, in range, and
accepted should not then be disregarded — and `0` has an obvious meaning that
the previous behaviour contradicted. To be ratified at CP-4 as an amendment to
the CP-2 line.
