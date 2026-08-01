import { describe, it, expect, beforeEach } from "vitest";
import { ConnectorRegistry } from "../src/registry/ConnectorRegistry.js";
import { ConnectorManager } from "../src/registry/ConnectorManager.js";
import { Dispatcher } from "../src/ops/Dispatcher.js";
import {
    RecordingMetricsSink,
    noopMetrics,
    prefixed,
    METRICS,
    startEventLoopLagMonitor,
} from "../src/infra/Metrics.js";
import { MemoryOperationStore } from "./harness/MemoryOperationStore.js";
import { makeFakeConnector, type FakeConnector } from "./harness/FakeConnector.js";
import { laneKeyFor } from "../src/ops/admission.js";
import type { EnqueueInput } from "../src/ops/OperationStore.js";

const OC = "__ACCOUNT__";

let store: MemoryOperationStore;
let registry: ConnectorRegistry;
let manager: ConnectorManager;
let dispatcher: Dispatcher;
let connector: FakeConnector;
let metrics: RecordingMetricsSink;

beforeEach(() => {
    metrics = new RecordingMetricsSink();
    store = new MemoryOperationStore();
    registry = new ConnectorRegistry();
    connector = makeFakeConnector();

    registry.registerFactory("fake", "1.0.0", async () => connector);
    registry.registerCapabilities("fake", "1.0.0", { equalitySearchOnName: true });
    registry.registerInstance("ad-prod", "fake", "1.0.0", {});

    manager = new ConnectorManager(registry, { metrics, logger: { error: () => {} } });
    dispatcher = new Dispatcher({
        store, manager, registry,
        config: { metrics, backoffBaseMs: 5, backoffMaxMs: 10, logger: { error: () => {} } },
    });
});

function enqueue(overrides: Partial<EnqueueInput> & { idempotencyKey: string }) {
    const base = { instanceId: "ad-prod", objectClass: OC, opType: "CREATE" as const, ...overrides };
    return store.enqueue({
        ...base,
        laneKey: base.laneKey ?? laneKeyFor(base.opType, base.objectClass, base),
    } as EnqueueInput);
}

async function drain(timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        await dispatcher.runCycle();
        await new Promise(r => setTimeout(r, 2));
        const open = store.allRows().some(r => r.status === "PENDING" || r.status === "RUNNING");
        if (!open && dispatcher.inFlightCount === 0) return;
    }
    throw new Error("drain timed out");
}

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

describe("dispatcher instrumentation", () => {
    it("counts a successful outcome by op and instance", async () => {
        await enqueue({ idempotencyKey: "m1", nameAttrValue: "a", attrs: { __NAME__: "a" } });
        await drain();

        expect(metrics.totalOf(METRICS.OUTCOME, {
            outcome: "SUCCEEDED", op: "CREATE", instance: "ad-prod",
        })).toBe(1);
    });

    it("distinguishes outcomes so a failure cannot hide inside a total", async () => {
        await connector.create!(OC, { __NAME__: "taken" });
        await enqueue({ idempotencyKey: "m2", nameAttrValue: "taken", attrs: { __NAME__: "taken" } });
        await enqueue({ idempotencyKey: "m3", nameAttrValue: "fresh", attrs: { __NAME__: "fresh" } });
        await drain();

        expect(metrics.totalOf(METRICS.OUTCOME, { outcome: "SUCCEEDED" })).toBe(1);
        expect(metrics.totalOf(METRICS.OUTCOME, { outcome: "FAILED_CONFIRMED" })).toBe(1);
    });

    it("counts requeues with the reason that caused them", async () => {
        const created = await connector.create!(OC, { __NAME__: "flaky" });
        connector.controls.failNext("CONNECTION_FAILED");

        await enqueue({ idempotencyKey: "m4", opType: "DELETE", uid: created.uid });
        await drain();

        expect(metrics.totalOf(METRICS.REQUEUED, { reason: "CONNECTION_FAILED" })).toBe(1);
        expect(metrics.totalOf(METRICS.OUTCOME, { outcome: "SUCCEEDED" })).toBe(1);
    });

    it("records claim cycle duration and claimed counts", async () => {
        await enqueue({ idempotencyKey: "m5", nameAttrValue: "c", attrs: { __NAME__: "c" } });
        await drain();

        expect(metrics.samplesOf(METRICS.CLAIM_CYCLE_MS).length).toBeGreaterThan(0);
        expect(metrics.totalOf(METRICS.CLAIMED)).toBe(1);
    });

    it("records attempt latency per instance and op", async () => {
        await enqueue({ idempotencyKey: "m6", nameAttrValue: "l", attrs: { __NAME__: "l" } });
        await drain();

        const samples = metrics.samplesOf(METRICS.ATTEMPT_LATENCY_MS, {
            instance: "ad-prod", op: "CREATE",
        });
        expect(samples).toHaveLength(1);
        expect(samples[0]).toBeGreaterThanOrEqual(0);
    });

    it("gauges how long a claimed operation waited", async () => {
        await enqueue({ idempotencyKey: "m7", nameAttrValue: "w", attrs: { __NAME__: "w" } });
        await drain();

        const age = metrics.latestGauge(METRICS.OLDEST_PENDING_AGE_MS, {
            instance: "ad-prod", priority: "batch",
        });
        expect(age).toBeGreaterThanOrEqual(0);
    });

    it("samples backlog depth", async () => {
        for (let i = 0; i < 3; i++) {
            await enqueue({ idempotencyKey: `d${i}`, nameAttrValue: `d${i}`, attrs: { __NAME__: `d${i}` } });
        }
        // The first cycle always samples; later ones are throttled so the
        // measurement does not out-cost the work being measured.
        await dispatcher.runCycle();

        expect(metrics.latestGauge(METRICS.BACKLOG_DEPTH, {
            instance: "ad-prod", priority: "batch",
        })).toBeGreaterThan(0);
        await drain();
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
