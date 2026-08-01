// src/ops/Dispatcher.ts
//
// Drains the operation table.
//
// Runs in-process, and multiple replicas coordinate through SKIP LOCKED alone
// -- no leader election, no external lock. Two dispatchers racing the same
// backlog simply partition it, and a dispatcher that dies mid-cycle loses only
// the rows it had claimed.

import type { ConnectorManager, Lease } from "../registry/ConnectorManager.js";
import type { ConnectorRegistry } from "../registry/ConnectorRegistry.js";
import { isDeadlineExpired } from "../registry/ConnectorFacade.js";
import { isConnectorError } from "../spi/errors.js";
import { RateLimiter } from "../infra/RateLimiter.js";
import { cmp } from "../filter/ast.js";
import type { OperationOptions, OperationOutcome, OperationPriority } from "../spi/types.js";
import type { ResolvedRuntimeConfig } from "../config/runtime.js";
import type { ClaimedOperation, OperationStoreApi } from "./OperationStore.js";

export interface DispatcherConfig {
  /** How often to attempt a claim cycle. Default 25ms. */
  claimIntervalMs?: number | undefined;
  /** Maximum rows claimed per cycle across all instances. Default 100. */
  claimBatchSize?: number | undefined;
  /** Retry ceiling for the ordinary backoff path. Default 5. */
  maxAttempts?: number | undefined;
  /** First backoff step. Default 1000ms. */
  backoffBaseMs?: number | undefined;
  /** Backoff ceiling. Default 60000ms. */
  backoffMaxMs?: number | undefined;
  /**
   * Extra delay added to the attempt deadline before a create read-back.
   * Default 2000ms.
   *
   * The read-back must never run before the attempt could possibly have
   * finished, or it reads the target mid-write and concludes the create
   * missed.
   */
  readBackGraceMs?: number | undefined;
  /** Clock seam for tests. */
  now?: (() => number) | undefined;
  logger?: { error(msg: string): void } | undefined;
}

/**
 * Config with every default applied.
 *
 * Spelled out rather than `Required<DispatcherConfig>`: the input fields are
 * declared `number | undefined` for exactOptionalPropertyTypes, and `Required`
 * strips the optionality without stripping the undefined from the type.
 */
interface ResolvedDispatcherConfig {
  claimIntervalMs: number;
  claimBatchSize: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  readBackGraceMs: number;
}

const DEFAULTS = {
  claimIntervalMs: 25,
  claimBatchSize: 100,
  maxAttempts: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  readBackGraceMs: 2_000,
} as const;

export interface DispatcherDeps {
  store: OperationStoreApi;
  manager: ConnectorManager;
  registry: ConnectorRegistry;
  config?: DispatcherConfig | undefined;
}

/** What one attempt concluded, before it is written to the store. */
interface Resolution {
  outcome: OperationOutcome | "REQUEUE";
  result?: unknown;
  errorCode?: string | null;
  /** Delay before the row becomes claimable again, for REQUEUE. */
  delayMs?: number;
}

export class Dispatcher {
  private readonly store: OperationStoreApi;
  private readonly manager: ConnectorManager;
  private readonly registry: ConnectorRegistry;
  private readonly cfg: ResolvedDispatcherConfig;
  private readonly now: () => number;
  private readonly logger: { error(msg: string): void };

  /** Lanes with an attempt in flight, excluded from the next claim. */
  private readonly activeLanes = new Set<string>();
  /** In-flight attempts per instance, so budgets reflect reality. */
  private readonly running = new Map<string, number>();
  /**
   * Lanes held out of claiming until a backoff elapses.
   *
   * Keyed by lane rather than by operation id, and enforced by excluding the
   * lane from the claim. Letting the row be claimed and then bounced would
   * requeue it -- incrementing attempt_count each time -- so a backoff would
   * silently consume the whole retry budget without ever reaching the target.
   */
  private readonly laneDeferredUntil = new Map<string, number>();
  private readonly limiters = new Map<string, RateLimiter>();
  /** Rotating start offset, so one instance cannot always claim first. */
  private roundRobinCursor = 0;

  private timer: ReturnType<typeof setInterval> | undefined;
  private cycleInFlight = false;
  private stopped = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: DispatcherDeps) {
    this.store = deps.store;
    this.manager = deps.manager;
    this.registry = deps.registry;

    const c = deps.config ?? {};
    this.cfg = {
      claimIntervalMs: c.claimIntervalMs ?? DEFAULTS.claimIntervalMs,
      claimBatchSize: c.claimBatchSize ?? DEFAULTS.claimBatchSize,
      maxAttempts: c.maxAttempts ?? DEFAULTS.maxAttempts,
      backoffBaseMs: c.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
      backoffMaxMs: c.backoffMaxMs ?? DEFAULTS.backoffMaxMs,
      readBackGraceMs: c.readBackGraceMs ?? DEFAULTS.readBackGraceMs,
    };
    this.now = c.now ?? (() => Date.now());
    this.logger = c.logger ?? { error: (m) => console.error(m) };
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.runCycle(); }, this.cfg.claimIntervalMs);
    this.timer.unref?.();
  }

  /** Stop claiming and wait for in-flight attempts to settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await Promise.allSettled([...this.inFlight]);
  }

  /** Attempts currently executing. */
  get inFlightCount(): number { return this.inFlight.size; }

  /**
   * Claim and dispatch one cycle's worth of work.
   *
   * Public so tests can step the loop deterministically instead of waiting on
   * a timer. Overlapping cycles are skipped rather than queued: the previous
   * cycle already holds the lanes and slots this one would compute from.
   */
  async runCycle(): Promise<number> {
    if (this.cycleInFlight || this.stopped) return 0;
    this.cycleInFlight = true;
    try {
      const available = this.computeAvailability();
      if (available.size === 0) return 0;

      const claimed = await this.store.claimBatch(
          this.cfg.claimBatchSize,
          this.excludedLanes(),
          available,
      );

      for (const op of claimed) {
        this.activeLanes.add(op.laneKey);
        this.running.set(op.instanceId, (this.running.get(op.instanceId) ?? 0) + 1);

        const task = this.execute(op).finally(() => {
          this.activeLanes.delete(op.laneKey);
          this.running.set(op.instanceId, Math.max(0, (this.running.get(op.instanceId) ?? 1) - 1));
        });
        this.inFlight.add(task);
        void task.finally(() => this.inFlight.delete(task));
      }

      return claimed.length;
    } finally {
      this.cycleInFlight = false;
    }
  }

  /**
   * Free mutation slots per instance, in round-robin order.
   *
   * Interactive work may draw on the whole budget; batch work is capped at the
   * budget minus the reserved slice. Since the claim query orders interactive
   * first, offering the full budget lets a burst of interactive work use every
   * slot while a steady batch backlog still leaves the slice free.
   */
  private computeAvailability(): Map<string, number> {
    const ids = this.registry.registeredIds();
    if (ids.length === 0) return new Map();

    // Rotate the starting point so a consistently busy instance early in the
    // list cannot monopolise the batch limit cycle after cycle.
    const offset = this.roundRobinCursor++ % ids.length;
    const ordered = [...ids.slice(offset), ...ids.slice(0, offset)];

    const out = new Map<string, number>();
    for (const instanceId of ordered) {
      const runtime = this.registry.getDefinition(instanceId)?.runtime;
      if (!runtime) continue;

      const inFlight = this.running.get(instanceId) ?? 0;
      const free = runtime.mutationConcurrency - inFlight;
      if (free <= 0) continue;

      if (!this.hasRateLimitTokens(instanceId, runtime)) continue;

      out.set(instanceId, free);
    }
    return out;
  }

  /**
   * Token-bucket admission for instances that declare a target rate limit.
   *
   * Checked before the claim rather than before the attempt: a row claimed and
   * then held back would sit RUNNING while its lane stayed blocked.
   */
  private hasRateLimitTokens(instanceId: string, runtime: ResolvedRuntimeConfig): boolean {
    const limits = runtime.rateLimits;
    const configured = limits.create ?? limits.update ?? limits.delete;
    if (!configured) return true;

    let limiter = this.limiters.get(instanceId);
    if (!limiter) {
      const perSecond = configured.requestLimit / (configured.requestPeriodMs / 1000);
      limiter = new RateLimiter(configured.requestLimit, perSecond);
      this.limiters.set(instanceId, limiter);
    }
    return limiter.tryConsume(1);
  }

  /** Lanes that must not be claimed this cycle: in flight, or inside a backoff. */
  private excludedLanes(): string[] {
    const now = this.now();
    for (const [lane, until] of this.laneDeferredUntil) {
      if (now >= until) this.laneDeferredUntil.delete(lane);
    }
    return [...new Set([...this.activeLanes, ...this.laneDeferredUntil.keys()])];
  }

  private async execute(op: ClaimedOperation): Promise<void> {
    let lease: Lease | undefined;
    try {
      lease = await this.manager.acquire(op.instanceId);
    } catch (e) {
      // Never reached the target: nothing happened, so this is safe to retry
      // wholesale rather than leaving it indeterminate.
      await this.finalize(op, {
        outcome: "REJECTED_PRE_DISPATCH",
        errorCode: "ACQUIRE_FAILED",
        result: { message: (e as Error).message },
      });
      return;
    }

    try {
      const resolution = await this.attempt(op, lease);
      await this.finalize(op, resolution);
    } catch (e) {
      this.logger.error(`[dispatcher] operation ${op.id} failed unexpectedly: ${(e as Error).message}`);
      await this.finalize(op, {
        outcome: "INDETERMINATE",
        errorCode: "DISPATCH_ERROR",
        result: { message: (e as Error).message },
      });
    } finally {
      lease.release();
    }
  }

  private optionsFor(op: ClaimedOperation, runtime: ResolvedRuntimeConfig): OperationOptions {
    const kind = op.opType === "CREATE" ? "create" : op.opType === "UPDATE" ? "update" : "delete";
    return {
      deadlineEpochMs: this.now() + runtime.attemptDeadlineMs[kind],
      priority: op.priority as OperationPriority,
    };
  }

  private async attempt(op: ClaimedOperation, lease: Lease): Promise<Resolution> {
    const runtime = this.registry.getDefinition(op.instanceId)?.runtime;
    if (!runtime) {
      return { outcome: "REJECTED_PRE_DISPATCH", errorCode: "UNKNOWN_INSTANCE" };
    }

    const options = this.optionsFor(op, runtime);
    const attrs = (op.attrs ?? {}) as Record<string, any>;

    switch (op.opType) {
      case "CREATE":  return this.attemptCreate(op, lease, runtime, options, attrs);
      case "UPDATE":  return this.attemptUpdate(op, lease, options, attrs);
      case "DELETE":  return this.attemptDelete(op, lease, options);
    }
  }

  // ---- CREATE ------------------------------------------------------------

  private async attemptCreate(
      op: ClaimedOperation,
      lease: Lease,
      runtime: ResolvedRuntimeConfig,
      options: OperationOptions,
      attrs: Record<string, any>,
  ): Promise<Resolution> {
    try {
      const created: any = await lease.facade.create(op.objectClass, attrs, options);
      // The target mints the Uid, so it exists only in this result. It is
      // persisted here and kept in history forever; losing it would leave a
      // successful create unlinkable to the account it made.
      return { outcome: "SUCCEEDED", result: { uid: created.uid, object: created } };
    } catch (e) {
      if (isConnectorError(e) && e.code === "ALREADY_EXISTS") {
        // Confirmed refusal. The rare delete-then-recreate race resolves
        // through the caller's own retry rather than a race classifier here.
        return { outcome: "FAILED_CONFIRMED", errorCode: "ALREADY_EXISTS" };
      }

      if (isDeadlineExpired(e)) return this.resolveCreateAfterDeadline(op, lease, runtime);

      if (isConnectorError(e) && e.retryable) {
        return this.backoffOrGiveUp(op, e.code, "INDETERMINATE");
      }

      return { outcome: "FAILED_CONFIRMED", errorCode: codeOf(e) };
    }
  }

  /**
   * Decide what a timed-out create actually did.
   *
   * The target may have applied it, so retrying blind is how duplicate
   * accounts happen. Instead: wait past the point the attempt could still have
   * been running, then look the object up by its naming attribute.
   */
  private async resolveCreateAfterDeadline(
      op: ClaimedOperation,
      lease: Lease,
      runtime: ResolvedRuntimeConfig,
  ): Promise<Resolution> {
    const caps = this.registry.capabilitiesOf(op.instanceId);
    if (!caps.equalitySearchOnName) {
      // No way to ask. Reconciliation is the backstop.
      return { outcome: "INDETERMINATE", errorCode: "DEADLINE_NO_READBACK" };
    }
    if (op.nameAttrValue === null || op.nameAttrValue === undefined) {
      return { outcome: "INDETERMINATE", errorCode: "DEADLINE_NO_NAME" };
    }

    const nameAttribute = await this.nameAttributeFor(lease, op.objectClass);
    await this.sleep(runtime.attemptDeadlineMs.create + this.cfg.readBackGraceMs);

    try {
      const found = await this.readBackByName(lease, op.objectClass, nameAttribute, op.nameAttrValue, runtime);
      if (found) {
        return { outcome: "SUCCEEDED", result: { uid: found.uid, object: found, viaReadBack: true } };
      }
    } catch (e) {
      // The read-back itself failed, so we still do not know.
      return { outcome: "INDETERMINATE", errorCode: `READBACK_FAILED:${codeOf(e)}` };
    }

    // Confirmed absent, so the create genuinely did not land. Exactly one
    // retry: a second miss means something other than a lost attempt.
    if (op.attemptCount < 1) {
      return { outcome: "REQUEUE", errorCode: "READBACK_MISS", delayMs: 0 };
    }
    return { outcome: "INDETERMINATE", errorCode: "READBACK_MISS" };
  }

  private async nameAttributeFor(lease: Lease, objectClass: string): Promise<string> {
    try {
      const schema: any = await lease.facade.schema();
      const oc = schema?.objectClasses?.find((c: any) => c.name === objectClass);
      if (oc?.nameAttribute) return String(oc.nameAttribute);
    } catch {
      // Schema is advisory here; the ICF default is the safe fallback.
    }
    return "__NAME__";
  }

  private async readBackByName(
      lease: Lease,
      objectClass: string,
      nameAttribute: string,
      nameValue: string,
      runtime: ResolvedRuntimeConfig,
  ): Promise<{ uid: string } | null> {
    const filter = cmp("EQ", [nameAttribute], nameValue);
    const res: any = await lease.facade.search(objectClass, filter, {
      pageSize: 2,
      deadlineEpochMs: this.now() + runtime.attemptDeadlineMs.search,
    });
    const results = res?.results ?? [];
    return results.length > 0 ? results[0] : null;
  }

  // ---- UPDATE ------------------------------------------------------------

  private async attemptUpdate(
      op: ClaimedOperation,
      lease: Lease,
      options: OperationOptions,
      attrs: Record<string, any>,
  ): Promise<Resolution> {
    try {
      const updated: any = await lease.facade.update(op.objectClass, op.uid!, attrs, options);
      return { outcome: "SUCCEEDED", result: { uid: updated?.uid ?? op.uid, object: updated } };
    } catch (e) {
      if (isConnectorError(e) && e.code === "UNKNOWN_UID") {
        return { outcome: "FAILED_CONFIRMED", errorCode: "UNKNOWN_UID" };
      }

      const retryable = isDeadlineExpired(e) || (isConnectorError(e) && e.retryable);
      if (!retryable) return { outcome: "FAILED_CONFIRMED", errorCode: codeOf(e) };

      // Full-replace updates are idempotent by construction, so replaying one
      // is safe. A delta -- increment, append, toggle -- is not, and replaying
      // it silently corrupts the target, so it retries only when the manifest
      // asserts the delta is idempotent.
      if (this.isDeltaUpdate(op) && !this.registry.capabilitiesOf(op.instanceId).idempotentDelta) {
        return { outcome: "INDETERMINATE", errorCode: "DELTA_NOT_IDEMPOTENT" };
      }

      return this.backoffOrGiveUp(op, codeOf(e), "INDETERMINATE");
    }
  }

  /**
   * Whether this update is a delta rather than a full replace.
   *
   * Marked by the enqueuing API on the payload. Absent the marker the
   * operation is treated as a replace, which matches the SPI's update
   * contract.
   */
  private isDeltaUpdate(op: ClaimedOperation): boolean {
    const attrs = op.attrs as Record<string, unknown> | null;
    return attrs?.["__DELTA__"] === true;
  }

  // ---- DELETE ------------------------------------------------------------

  private async attemptDelete(
      op: ClaimedOperation,
      lease: Lease,
      options: OperationOptions,
  ): Promise<Resolution> {
    try {
      await lease.facade.delete(op.objectClass, op.uid!, options);
      return { outcome: "SUCCEEDED", result: { uid: op.uid } };
    } catch (e) {
      // The desired end state is "object absent", and it is absent. Treating
      // this as a failure would make every retry of a successful delete look
      // like an error.
      if (isConnectorError(e) && e.code === "UNKNOWN_UID") {
        return { outcome: "SUCCEEDED", result: { uid: op.uid, alreadyAbsent: true } };
      }

      const retryable = isDeadlineExpired(e) || (isConnectorError(e) && e.retryable);
      if (!retryable) return { outcome: "FAILED_CONFIRMED", errorCode: codeOf(e) };

      // Delete is idempotent: a replay either removes it or reports
      // UNKNOWN_UID, which resolves to success above.
      return this.backoffOrGiveUp(op, codeOf(e), "INDETERMINATE");
    }
  }

  // ---- shared ------------------------------------------------------------

  /** Requeue with exponential backoff, or give up once the attempt cap is hit. */
  private backoffOrGiveUp(
      op: ClaimedOperation,
      errorCode: string,
      exhausted: OperationOutcome,
  ): Resolution {
    if (op.attemptCount + 1 >= this.cfg.maxAttempts) {
      return { outcome: exhausted, errorCode };
    }
    const delayMs = Math.min(
        this.cfg.backoffMaxMs,
        this.cfg.backoffBaseMs * Math.pow(2, op.attemptCount),
    );
    return { outcome: "REQUEUE", errorCode, delayMs };
  }

  private async finalize(op: ClaimedOperation, r: Resolution): Promise<void> {
    if (r.outcome === "REQUEUE") {
      if (r.delayMs && r.delayMs > 0) {
        this.laneDeferredUntil.set(op.laneKey, this.now() + r.delayMs);
      }
      await this.safeRequeue(op.id);
      return;
    }
    try {
      await this.store.finalize(op.id, r.outcome, r.result, r.errorCode ?? null);
    } catch (e) {
      this.logger.error(`[dispatcher] finalize failed for ${op.id}: ${(e as Error).message}`);
    }
  }

  private async safeRequeue(id: string): Promise<void> {
    try {
      await this.store.requeue(id);
    } catch (e) {
      this.logger.error(`[dispatcher] requeue failed for ${id}: ${(e as Error).message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise(res => { setTimeout(res, ms); });
  }
}

function codeOf(e: unknown): string {
  if (isDeadlineExpired(e)) return "DEADLINE_EXPIRED";
  if (isConnectorError(e)) return e.code;
  return "UNKNOWN";
}
