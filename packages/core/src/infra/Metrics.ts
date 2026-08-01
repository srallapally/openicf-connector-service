// src/infra/Metrics.ts
//
// Metrics as an interface, not an implementation.
//
// The framework is a library: it cannot know whether the embedder runs
// Prometheus, OpenTelemetry, Cloud Monitoring, or nothing at all, and pulling
// in a client library would force that choice on every consumer. So the
// framework emits, the embedder collects, and the default sink does nothing.

/** Dimensions attached to a measurement. Keep cardinality low. */
export type MetricLabels = Record<string, string>;

/**
 * Where measurements go.
 *
 * Three primitives, matching what every backend already has:
 *
 * - counter: monotonic totals (operations by outcome)
 * - gauge: a value at a point in time (backlog depth, live instances)
 * - histogram: a distribution (attempt latency)
 */
export interface MetricsSink {
  counter(name: string, value: number, labels?: MetricLabels): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
  histogram(name: string, value: number, labels?: MetricLabels): void;
}

/** Metric names the framework emits. Stable; treat as API. */
export const METRICS = {
  /**
   * PENDING operations per instance and class.
   *
   * With oldest-pending age, the primary health signal: a backlog that is
   * merely large is fine if it is draining, and a small one that is not
   * draining is not.
   */
  BACKLOG_DEPTH: "gcf.operations.backlog_depth",
  /** Age of the oldest PENDING operation, in ms. */
  OLDEST_PENDING_AGE_MS: "gcf.operations.oldest_pending_age_ms",
  /** Wall time of one claim cycle, in ms. */
  CLAIM_CYCLE_MS: "gcf.dispatcher.claim_cycle_ms",
  /** Rows claimed per cycle. */
  CLAIMED: "gcf.dispatcher.claimed",
  /** Terminal outcomes, labelled by outcome and op type. */
  OUTCOME: "gcf.operations.outcome",
  /** Requeues, labelled by reason. */
  REQUEUED: "gcf.operations.requeued",
  /** Creates parked to await a read-back rather than holding a slot. */
  DEFERRED_READBACK: "gcf.operations.deferred_readback",
  /** Rows recovered from a dead dispatcher, labelled by the route taken. */
  REAPED: "gcf.operations.reaped",
  /** End-to-end attempt latency per instance, in ms. */
  ATTEMPT_LATENCY_MS: "gcf.operations.attempt_latency_ms",
  /** Circuit breaker state transitions. */
  BREAKER_TRANSITION: "gcf.breaker.transition",
  /** Event loop lag, in ms. The signal that decides the sidecar split. */
  EVENT_LOOP_LAG_MS: "gcf.runtime.event_loop_lag_ms",
  /** Connector instances currently constructed. */
  LIVE_INSTANCES: "gcf.manager.live_instances",
  /** Pooled connections in use and idle. */
  POOL_USED: "gcf.pool.used",
  POOL_FREE: "gcf.pool.free",
} as const;

/** Discards everything. The default, so metrics are never a hard dependency. */
export const noopMetrics: MetricsSink = {
  counter() {},
  gauge() {},
  histogram() {},
};

/**
 * Prefix every metric name from an inner sink.
 *
 * Useful when several frameworks share one registry and their names would
 * otherwise collide.
 */
export function prefixed(sink: MetricsSink, prefix: string): MetricsSink {
  return {
    counter: (n, v, l) => sink.counter(`${prefix}${n}`, v, l),
    gauge: (n, v, l) => sink.gauge(`${prefix}${n}`, v, l),
    histogram: (n, v, l) => sink.histogram(`${prefix}${n}`, v, l),
  };
}

/**
 * A sink that records in memory. For tests and local debugging.
 *
 * Not for production: it grows without bound.
 */
export class RecordingMetricsSink implements MetricsSink {
  readonly counters: Array<{ name: string; value: number; labels: MetricLabels }> = [];
  readonly gauges: Array<{ name: string; value: number; labels: MetricLabels }> = [];
  readonly histograms: Array<{ name: string; value: number; labels: MetricLabels }> = [];

  counter(name: string, value: number, labels: MetricLabels = {}): void {
    this.counters.push({ name, value, labels });
  }
  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.gauges.push({ name, value, labels });
  }
  histogram(name: string, value: number, labels: MetricLabels = {}): void {
    this.histograms.push({ name, value, labels });
  }

  /** Summed counter value, optionally filtered by label subset. */
  totalOf(name: string, labels: MetricLabels = {}): number {
    return this.counters
        .filter(c => c.name === name && matches(c.labels, labels))
        .reduce((sum, c) => sum + c.value, 0);
  }

  /** Most recent gauge reading, or undefined if never recorded. */
  latestGauge(name: string, labels: MetricLabels = {}): number | undefined {
    for (let i = this.gauges.length - 1; i >= 0; i--) {
      const g = this.gauges[i]!;
      if (g.name === name && matches(g.labels, labels)) return g.value;
    }
    return undefined;
  }

  /** Every histogram sample recorded under a name. */
  samplesOf(name: string, labels: MetricLabels = {}): number[] {
    return this.histograms
        .filter(h => h.name === name && matches(h.labels, labels))
        .map(h => h.value);
  }

  clear(): void {
    this.counters.length = 0;
    this.gauges.length = 0;
    this.histograms.length = 0;
  }
}

function matches(actual: MetricLabels, expected: MetricLabels): boolean {
  return Object.entries(expected).every(([k, v]) => actual[k] === v);
}

/**
 * Sample event-loop lag.
 *
 * CP-1 defers the in-process versus sidecar decision until production shows
 * whether the dispatcher starves the event loop. This is the measurement that
 * decision waits on, so it is wired from the start rather than added once the
 * question becomes urgent.
 *
 * Uses monitorEventLoopDelay, which samples in libuv rather than by scheduling
 * timers, so measuring does not itself add load.
 */
export interface EventLoopLagMonitor {
  /** Emit current lag percentiles and reset the window. */
  sample(): void;
  stop(): void;
}

export async function startEventLoopLagMonitor(
    sink: MetricsSink,
    intervalMs = 10_000,
): Promise<EventLoopLagMonitor> {
  const { monitorEventLoopDelay } = await import("node:perf_hooks");
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();

  // An empty window reports NaN for mean and percentile. Forwarding that would
  // poison a metrics backend's aggregations, so an unsampled window reads as
  // zero lag -- which is what it means.
  const ms = (nanos: number) => Number.isFinite(nanos) ? nanos / 1e6 : 0;

  const emit = () => {
    sink.gauge(METRICS.EVENT_LOOP_LAG_MS, ms(histogram.mean), { quantile: "mean" });
    sink.gauge(METRICS.EVENT_LOOP_LAG_MS, ms(histogram.percentile(99)), { quantile: "p99" });
    histogram.reset();
  };

  const timer = setInterval(emit, intervalMs);
  timer.unref?.();

  return {
    sample: emit,
    stop: () => {
      clearInterval(timer);
      histogram.disable();
    },
  };
}
