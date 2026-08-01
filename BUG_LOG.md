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
| [BUG-1](#bug-1) | medium | OPEN | `ops/Dispatcher` | Create read-back sleeps inline, holding the lease and mutation slot |

---

<a id="bug-1"></a>
## BUG-1 — Create read-back sleeps inline, holding the lease and mutation slot

| | |
|---|---|
| **Severity** | medium |
| **Status** | OPEN |
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

### Notes

Deliberately not fixed on report. The right shape touches the store contract and
the status model, so it warrants its own phase rather than a patch.
