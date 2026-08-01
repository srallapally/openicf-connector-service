// src/registry/ConnectorManager.ts
//
// Owns the lifecycle of live connector instances for the data path.
//
// The registry knows what instances exist and how to build one. The manager
// decides when one is built, how long it stays, and who is currently using it.
// Splitting those two concerns is what makes lazy construction, refcounted
// leases, and idle eviction possible without threading lifecycle state through
// every call site.

import type { ConnectorInstance, ConnectorRegistry } from "./ConnectorRegistry.js";
import { ConnectorFacade } from "./ConnectorFacade.js";
import { makePooledSpi } from "./pooledSpi.js";
import type { Pooled } from "../infra/Pool.js";
import type { ConnectorSpi } from "../spi/types.js";
import { noopMetrics, METRICS, type MetricsSink } from "../infra/Metrics.js";

/**
 * A borrowed connector.
 *
 * Holding a lease guarantees the instance will not be disposed underneath the
 * caller. Exactly one `release()` per `acquire()`; the idiom is a `finally`.
 *
 * Only the facade is exposed. A raw SPI reference would bypass the circuit
 * breaker and the deadline, and -- worse -- would still be usable after
 * release, when the manager believes nobody holds the instance.
 */
export interface Lease {
  readonly instanceId: string;
  readonly facade: ConnectorFacade;
  /** Idempotent: a second call is a no-op, not a double decrement. */
  release(): void;
}

export interface ConnectorManagerOptions {
  /**
   * How long an unused instance survives before disposal. Default 15 minutes.
   *
   * Long enough that a periodic job hitting the same target every few minutes
   * keeps its connection, short enough that a one-off never holds one for the
   * life of the process.
   */
  idleTtlMs?: number;
  /** Hard ceiling on live instances. Default 200. */
  maxLiveInstances?: number;
  /** How often to look for idle instances. Default 60s. */
  sweepIntervalMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
  logger?: { error(msg: string): void };
  /** Where measurements go. Defaults to discarding them. */
  metrics?: MetricsSink;
}

const DEFAULTS = {
  idleTtlMs: 15 * 60_000,
  maxLiveInstances: 200,
  sweepIntervalMs: 60_000,
} as const;

interface LiveEntry {
  readonly instanceId: string;
  /** Published before the first await, so concurrent acquires share one build. */
  promise: Promise<Materialized>;
  refcount: number;
  lastUsedAt: number;
  /** Set once resolved, so eviction can dispose without re-awaiting. */
  settled: Materialized | undefined;
  disposing: boolean;
}

interface Materialized {
  instance: ConnectorInstance;
  facade: ConnectorFacade;
  /** Present only for poolable connectors; drained on eviction and shutdown. */
  pool: Pooled<ConnectorSpi> | undefined;
}

export class ConnectorManager {
  private readonly live = new Map<string, LiveEntry>();
  private readonly idleTtlMs: number;
  private readonly maxLiveInstances: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly logger: { error(msg: string): void };
  private readonly metrics: MetricsSink;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private shuttingDown = false;

  constructor(
      private readonly registry: ConnectorRegistry,
      opts: ConnectorManagerOptions = {},
  ) {
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULTS.idleTtlMs;
    this.maxLiveInstances = opts.maxLiveInstances ?? DEFAULTS.maxLiveInstances;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs;
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? { error: (m) => console.error(m) };
    this.metrics = opts.metrics ?? noopMetrics;
  }

  /** Number of instances currently constructed. */
  get liveCount(): number { return this.live.size; }

  /** Outstanding leases for an instance; 0 means evictable. */
  refcountOf(instanceId: string): number {
    return this.live.get(instanceId)?.refcount ?? 0;
  }

  /** Begin periodic idle sweeps. The timer is unref'd so it never holds the process open. */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => { void this.sweep(); }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /**
   * Borrow a connector, constructing it if this is the first use.
   *
   * The map entry and its promise are published before anything is awaited,
   * which closes the check-then-act window: a second caller arriving mid-build
   * finds the in-flight promise instead of concluding the instance does not
   * exist and building a second one.
   */
  async acquire(instanceId: string): Promise<Lease> {
    if (this.shuttingDown) {
      throw new Error(`ConnectorManager is shutting down; cannot acquire '${instanceId}'`);
    }

    let entry = this.live.get(instanceId);

    if (!entry) {
      const created: LiveEntry = {
        instanceId,
        promise: undefined as unknown as Promise<Materialized>,
        refcount: 0,
        lastUsedAt: this.now(),
        settled: undefined,
        disposing: false,
      };
      // Publish first, then start the build. Reversing these two lines is the
      // whole bug this design exists to prevent.
      this.live.set(instanceId, created);
      created.promise = this.materialize(instanceId, created);
      entry = created;
    }

    // Reserve the reference before awaiting. A sweep running while the factory
    // is still in flight would otherwise see refcount 0 and evict an instance
    // somebody is already waiting on.
    entry.refcount++;
    entry.lastUsedAt = this.now();

    let materialized: Materialized;
    try {
      materialized = await entry.promise;
    } catch (e) {
      entry.refcount--;
      throw e;
    }

    this.enforceCap();
    return this.makeLease(entry, materialized);
  }

  private async materialize(instanceId: string, entry: LiveEntry): Promise<Materialized> {
    try {
      const instance = await this.registry.materializeInstance(instanceId);
      const capabilities = this.registry.capabilitiesOf(instanceId);

      let impl: ConnectorSpi = instance.impl;
      let pool: Pooled<ConnectorSpi> | undefined;

      if (capabilities.poolable) {
        // A stateful protocol scales by opening more connections, so the
        // facade talks to a pool rather than to one connector. Sized to the
        // two concurrency budgets summed, which is the most in-flight work
        // this instance can have.
        const built = await makePooledSpi(
            () => this.registry.createSpi(instanceId),
            { max: instance.runtime.mutationConcurrency + instance.runtime.readConcurrency },
        );
        impl = built.spi;
        pool = built.pool;

        // The instance built during materialization is not the pool's, so
        // disposing it here keeps a stray connection from outliving nothing.
        await this.disposeSpi(instanceId, instance.impl);
      }

      // The manager's clock is deliberately not passed down. The facade's
      // deadlines are enforced with setTimeout, so its notion of "now" must be
      // the same one the timer wheel uses; the manager's injectable clock only
      // drives idle accounting.
      const facade = new ConnectorFacade(impl, instance.id, {
        runtime: instance.runtime,
      });
      const result: Materialized = { instance, facade, pool };
      entry.settled = result;
      this.metrics.gauge(METRICS.LIVE_INSTANCES, this.live.size);
      return result;
    } catch (e) {
      // Drop the failed entry before rethrowing so the next acquire retries
      // rather than replaying a cached rejection forever. Only remove our own
      // entry: a later acquire may already have installed a fresh one.
      if (this.live.get(instanceId) === entry) this.live.delete(instanceId);
      throw e;
    }
  }

  private makeLease(entry: LiveEntry, m: Materialized): Lease {
    let released = false;
    return {
      instanceId: entry.instanceId,
      facade: m.facade,
      release: () => {
        // Idempotent: a caller that releases in both a catch and a finally
        // must not drive the refcount negative and make the instance look
        // evictable while it is still in use.
        if (released) return;
        released = true;
        entry.refcount--;
        entry.lastUsedAt = this.now();
      },
    };
  }

  /**
   * Dispose instances that are unused and have been idle past the TTL.
   *
   * Public so tests can drive it directly instead of waiting on a timer.
   */
  async sweep(): Promise<void> {
    const now = this.now();
    const expired: LiveEntry[] = [];

    // The sweep is the natural cadence for pool occupancy: frequent enough to
    // spot saturation, rare enough not to poll tarn on every operation.
    this.metrics.gauge(METRICS.LIVE_INSTANCES, this.live.size);
    for (const entry of this.live.values()) {
      const pool = entry.settled?.pool;
      if (!pool) continue;
      const stats = pool.stats();
      this.metrics.gauge(METRICS.POOL_USED, stats.used, { instance: entry.instanceId });
      this.metrics.gauge(METRICS.POOL_FREE, stats.free, { instance: entry.instanceId });
    }

    for (const entry of this.live.values()) {
      if (entry.refcount > 0 || entry.disposing) continue;
      if (now - entry.lastUsedAt < this.idleTtlMs) continue;
      expired.push(entry);
    }

    await Promise.all(expired.map(e => this.evict(e)));
    this.enforceCap();
  }

  /**
   * Hold the live set at or below the cap by evicting least-recently-used
   * unused instances.
   *
   * Instances with outstanding leases are never candidates, so a workload with
   * more concurrent instances than the cap will exceed it rather than break
   * correctness. That is the right trade: the cap protects memory, and
   * disposing a connector mid-operation would not.
   */
  private enforceCap(): void {
    if (this.live.size <= this.maxLiveInstances) return;

    const candidates = Array.from(this.live.values())
        .filter(e => e.refcount === 0 && !e.disposing)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    let overBy = this.live.size - this.maxLiveInstances;
    for (const entry of candidates) {
      if (overBy <= 0) break;
      void this.evict(entry);
      overBy--;
    }
  }

  /**
   * Remove an instance and dispose it.
   *
   * The map entry goes first, before the await: a concurrent acquire then
   * builds a fresh instance rather than queueing behind a teardown, and can
   * never receive a facade whose connector is being disposed.
   */
  private async evict(entry: LiveEntry): Promise<void> {
    if (entry.disposing) return;
    if (entry.refcount > 0) return;

    entry.disposing = true;
    if (this.live.get(entry.instanceId) === entry) {
      this.live.delete(entry.instanceId);
    }

    // A build that failed leaves nothing to dispose.
    const materialized = entry.settled ?? await entry.promise.catch(() => undefined);
    if (!materialized) return;

    await this.teardown(entry.instanceId, materialized);
  }

  /**
   * Release whatever the instance holds.
   *
   * A pooled instance drains its pool -- destroying every connection in it --
   * rather than disposing the single connector built during materialization,
   * which was already released at that point.
   */
  private async teardown(instanceId: string, m: Materialized): Promise<void> {
    this.metrics.gauge(METRICS.LIVE_INSTANCES, this.live.size);
    if (m.pool) {
      try {
        const stats = m.pool.stats();
        this.metrics.gauge(METRICS.POOL_USED, stats.used, { instance: instanceId });
        this.metrics.gauge(METRICS.POOL_FREE, stats.free, { instance: instanceId });
        await m.pool.destroyAll();
      } catch (e) {
        this.logger.error(
            `[manager] pool drain failed for instance ${instanceId}: ${(e as Error).message}`,
        );
      }
      return;
    }
    await this.disposeSpi(instanceId, m.instance.impl);
  }

  private async disposeSpi(instanceId: string, impl: ConnectorSpi): Promise<void> {
    try {
      await impl.dispose?.();
    } catch (e) {
      // Teardown failure must never propagate: it would abort a sweep or a
      // shutdown partway through and strand every instance after this one.
      this.logger.error(
          `[manager] dispose failed for instance ${instanceId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Stop sweeping and dispose every live instance.
   *
   * Sequential, matching the registry: connectors may share process-level
   * resources, and nothing requires parallel teardown.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }

    for (const entry of Array.from(this.live.values())) {
      this.live.delete(entry.instanceId);
      if (entry.disposing) continue;
      entry.disposing = true;
      const materialized = entry.settled ?? await entry.promise.catch(() => undefined);
      if (materialized) await this.teardown(entry.instanceId, materialized);
    }
  }
}
