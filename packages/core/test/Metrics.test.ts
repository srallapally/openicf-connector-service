import { describe, it, expect, beforeEach } from "vitest";
import { ConnectorRegistry } from "../src/registry/ConnectorRegistry.js";
import { ConnectorManager } from "../src/registry/ConnectorManager.js";
import {
    RecordingMetricsSink,
    noopMetrics,
    prefixed,
    METRICS,
    startEventLoopLagMonitor,
} from "../src/infra/Metrics.js";
import { makeFakeConnector, type FakeConnector } from "../src/testing/FakeConnector.js";

let registry: ConnectorRegistry;
let manager: ConnectorManager;
let connector: FakeConnector;
let metrics: RecordingMetricsSink;

beforeEach(() => {
    metrics = new RecordingMetricsSink();
    registry = new ConnectorRegistry();
    connector = makeFakeConnector();

    registry.registerFactory("fake", "1.0.0", async () => connector);
    registry.registerInstance("ad-prod", "fake", "1.0.0", {});
    manager = new ConnectorManager(registry, { metrics, logger: { error: () => {} } });
});

describe("MetricsSink contract", () => {
    it("discards everything by default, so metrics are never a hard dependency", () => {
        expect(() => {
            noopMetrics.counter("x", 1);
            noopMetrics.gauge("y", 2, { a: "b" });
            noopMetrics.histogram("z", 3);
        }).not.toThrow();
    });

    it("prefixes names without touching values or labels", () => {
        const inner = new RecordingMetricsSink();
        const sink = prefixed(inner, "app.");

        sink.counter("ops", 2, { instance: "a" });
        sink.gauge("depth", 7);
        sink.histogram("latency", 12);

        expect(inner.counters[0]).toEqual({ name: "app.ops", value: 2, labels: { instance: "a" } });
        expect(inner.gauges[0]!.name).toBe("app.depth");
        expect(inner.histograms[0]!.value).toBe(12);
    });

    it("filters recorded values by label subset", () => {
        const sink = new RecordingMetricsSink();
        sink.counter("n", 1, { instance: "a", op: "CREATE" });
        sink.counter("n", 2, { instance: "b", op: "CREATE" });
        sink.counter("n", 4, { instance: "a", op: "DELETE" });

        expect(sink.totalOf("n")).toBe(7);
        expect(sink.totalOf("n", { instance: "a" })).toBe(5);
        expect(sink.totalOf("n", { instance: "a", op: "DELETE" })).toBe(4);
    });
});

describe("manager instrumentation", () => {
    it("gauges live instance count as instances are built and evicted", async () => {
        let t = 1_000_000;
        manager = new ConnectorManager(registry, {
            metrics, idleTtlMs: 10, now: () => t, logger: { error: () => {} },
        });

        const lease = await manager.acquire("ad-prod");
        expect(metrics.latestGauge(METRICS.LIVE_INSTANCES)).toBe(1);

        lease.release();
        t += 1_000;
        await manager.sweep();

        expect(metrics.latestGauge(METRICS.LIVE_INSTANCES)).toBe(0);
    });
});

describe("event loop lag", () => {
    it("samples mean and p99 without scheduling timers to measure itself", async () => {
        const sink = new RecordingMetricsSink();
        const monitor = await startEventLoopLagMonitor(sink, 60_000);
        try {
            await new Promise(r => setTimeout(r, 20));
            monitor.sample();

            expect(sink.latestGauge(METRICS.EVENT_LOOP_LAG_MS, { quantile: "mean" }))
                .toBeGreaterThanOrEqual(0);
            expect(sink.latestGauge(METRICS.EVENT_LOOP_LAG_MS, { quantile: "p99" }))
                .toBeGreaterThanOrEqual(0);
        } finally {
            monitor.stop();
        }
    });
});
