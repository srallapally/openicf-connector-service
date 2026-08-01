import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConnectorRegistry } from "../src/registry/ConnectorRegistry.js";
import { ConnectorManager } from "../src/registry/ConnectorManager.js";
import { makeFakeConnector } from "./harness/FakeConnector.js";
import { deferred, barrier, flushMicrotasks } from "./harness/async.js";

/** A manual clock, so TTL assertions never depend on wall time. */
function testClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

let registry: ConnectorRegistry;
let clock: ReturnType<typeof testClock>;

beforeEach(() => {
    registry = new ConnectorRegistry();
    clock = testClock();
});

function register(id: string, factory: () => Promise<any>, type = "fake"): void {
    if (!registry.getVersions(type).includes("1.0.0")) {
        registry.registerFactory(type, "1.0.0", factory);
    }
    registry.registerInstance(id, type, "1.0.0", {});
}

function manager(opts: Partial<ConstructorParameters<typeof ConnectorManager>[1]> = {}) {
    return new ConnectorManager(registry, {
        now: clock.now,
        logger: { error: () => { /* silence expected teardown noise */ } },
        ...opts,
    });
}

describe("acquire", () => {
    it("constructs lazily: registration alone builds nothing", async () => {
        // CP-1 rejected eager boot outright -- minutes of startup and a
        // thundering herd against targets nobody asked for.
        let built = 0;
        register("a", async () => { built++; return makeFakeConnector(); });

        const m = manager();
        expect(built).toBe(0);
        expect(registry.isMaterialized("a")).toBe(false);

        await m.acquire("a");
        expect(built).toBe(1);
    });

    it("runs the factory once when two acquires race the first build", async () => {
        // The TOCTOU case: both callers must be inside acquire before either
        // factory resolves, which is exactly what the barrier forces.
        const gate = deferred<void>();
        const bothIn = barrier(2);
        let built = 0;

        register("a", async () => {
            built++;
            await gate.promise;
            return makeFakeConnector();
        });

        const m = manager();
        const first = m.acquire("a").then(async l => { await bothIn.arrive(); return l; });
        const second = m.acquire("a").then(async l => { await bothIn.arrive(); return l; });

        await flushMicrotasks();
        gate.resolve();

        const [a, b] = await Promise.all([first, second]);
        expect(built).toBe(1);
        expect(a.facade).toBe(b.facade);   // one facade, cached in the manager
        expect(m.refcountOf("a")).toBe(2);
    });

    it("caches the facade across sequential acquires", async () => {
        register("a", async () => makeFakeConnector());
        const m = manager();

        const first = await m.acquire("a");
        first.release();
        const second = await m.acquire("a");

        expect(second.facade).toBe(first.facade);
        expect(m.liveCount).toBe(1);
    });

    it("drops a failed build so the next acquire retries", async () => {
        let attempts = 0;
        register("a", async () => {
            attempts++;
            if (attempts === 1) throw new Error("target unreachable");
            return makeFakeConnector();
        });

        const m = manager();
        await expect(m.acquire("a")).rejects.toThrow("target unreachable");
        // A cached rejection here would make one transient failure permanent.
        expect(m.liveCount).toBe(0);

        await expect(m.acquire("a")).resolves.toBeDefined();
        expect(attempts).toBe(2);
    });

    it("does not leak a reference when the build fails", async () => {
        register("a", async () => { throw new Error("boom"); });
        const m = manager();
        await expect(m.acquire("a")).rejects.toThrow();
        expect(m.refcountOf("a")).toBe(0);
    });

    it("propagates an unknown instance id", async () => {
        const m = manager();
        await expect(m.acquire("nope")).rejects.toThrow(/not registered/);
    });

    it("hands out only the facade, never the raw SPI", async () => {
        register("a", async () => makeFakeConnector());
        const lease = await manager().acquire("a");

        expect(lease.facade).toBeDefined();
        expect((lease as Record<string, unknown>)["impl"]).toBeUndefined();
        expect((lease as Record<string, unknown>)["spi"]).toBeUndefined();
    });
});

describe("leases and refcounting", () => {
    it("counts each acquire and each release", async () => {
        register("a", async () => makeFakeConnector());
        const m = manager();

        const l1 = await m.acquire("a");
        const l2 = await m.acquire("a");
        expect(m.refcountOf("a")).toBe(2);

        l1.release();
        expect(m.refcountOf("a")).toBe(1);
        l2.release();
        expect(m.refcountOf("a")).toBe(0);
    });

    it("ignores a double release", async () => {
        // A caller releasing in both a catch and a finally must not make the
        // instance look evictable while another lease still holds it.
        register("a", async () => makeFakeConnector());
        const m = manager();

        const l1 = await m.acquire("a");
        const l2 = await m.acquire("a");

        l1.release();
        l1.release();
        l1.release();

        expect(m.refcountOf("a")).toBe(1);
        l2.release();
        expect(m.refcountOf("a")).toBe(0);
    });

    it("never disposes inline on release", async () => {
        const connector = makeFakeConnector();
        register("a", async () => connector);
        const m = manager();

        (await m.acquire("a")).release();

        expect(connector.controls.countOf("dispose")).toBe(0);
        expect(m.liveCount).toBe(1);
    });
});

describe("idle eviction", () => {
    it("disposes an unused instance once the TTL elapses", async () => {
        const connector = makeFakeConnector();
        register("a", async () => connector);
        const m = manager({ idleTtlMs: 1000 });

        (await m.acquire("a")).release();

        clock.advance(999);
        await m.sweep();
        expect(m.liveCount).toBe(1);       // not yet

        clock.advance(2);
        await m.sweep();
        expect(m.liveCount).toBe(0);
        expect(connector.controls.countOf("dispose")).toBe(1);
    });

    it("never evicts an instance with an outstanding lease", async () => {
        const connector = makeFakeConnector();
        register("a", async () => connector);
        const m = manager({ idleTtlMs: 1000 });

        const lease = await m.acquire("a");
        clock.advance(60_000);
        await m.sweep();

        expect(m.liveCount).toBe(1);
        expect(connector.controls.countOf("dispose")).toBe(0);

        lease.release();
        clock.advance(60_000);
        await m.sweep();
        expect(connector.controls.countOf("dispose")).toBe(1);
    });

    it("restarts the idle window on reuse", async () => {
        register("a", async () => makeFakeConnector());
        const m = manager({ idleTtlMs: 1000 });

        (await m.acquire("a")).release();
        clock.advance(900);

        (await m.acquire("a")).release();   // touched again
        clock.advance(900);
        await m.sweep();

        expect(m.liveCount).toBe(1);
    });

    it("keeps sweeping when one connector's dispose throws", async () => {
        const bad = makeFakeConnector();
        (bad as any).dispose = async () => { throw new Error("teardown failed"); };
        const good = makeFakeConnector();

        registry.registerFactory("bad", "1.0.0", async () => bad);
        registry.registerFactory("good", "1.0.0", async () => good);
        registry.registerInstance("bad", "bad", "1.0.0", {});
        registry.registerInstance("good", "good", "1.0.0", {});

        const m = manager({ idleTtlMs: 0 });
        (await m.acquire("bad")).release();
        (await m.acquire("good")).release();

        clock.advance(10);
        await expect(m.sweep()).resolves.toBeUndefined();

        expect(m.liveCount).toBe(0);
        expect(good.controls.countOf("dispose")).toBe(1);
    });
});

describe("live-instance cap", () => {
    it("evicts least-recently-used unused instances first", async () => {
        const connectors = new Map<string, ReturnType<typeof makeFakeConnector>>();
        for (const id of ["a", "b", "c"]) {
            const c = makeFakeConnector();
            connectors.set(id, c);
            registry.registerFactory(id, "1.0.0", async () => c);
            registry.registerInstance(id, id, "1.0.0", {});
        }

        const m = manager({ maxLiveInstances: 2 });

        (await m.acquire("a")).release();   // oldest
        clock.advance(10);
        (await m.acquire("b")).release();
        clock.advance(10);

        (await m.acquire("c")).release();   // pushes over the cap
        await flushMicrotasks();

        expect(m.liveCount).toBe(2);
        expect(connectors.get("a")!.controls.countOf("dispose")).toBe(1);
        expect(connectors.get("b")!.controls.countOf("dispose")).toBe(0);
        expect(connectors.get("c")!.controls.countOf("dispose")).toBe(0);
    });

    it("exceeds the cap rather than evicting an in-use instance", async () => {
        // Memory protection must never win over correctness: disposing a
        // connector mid-operation would break the operation and free nothing
        // that was actually idle.
        const held: Array<{ release(): void }> = [];
        for (const id of ["a", "b", "c"]) {
            registry.registerFactory(id, "1.0.0", async () => makeFakeConnector());
            registry.registerInstance(id, id, "1.0.0", {});
        }

        const m = manager({ maxLiveInstances: 1 });
        for (const id of ["a", "b", "c"]) held.push(await m.acquire(id));
        await flushMicrotasks();

        expect(m.liveCount).toBe(3);
        for (const lease of held) lease.release();
    });
});

describe("shutdown", () => {
    it("disposes every live instance", async () => {
        const a = makeFakeConnector();
        const b = makeFakeConnector();
        registry.registerFactory("a", "1.0.0", async () => a);
        registry.registerFactory("b", "1.0.0", async () => b);
        registry.registerInstance("a", "a", "1.0.0", {});
        registry.registerInstance("b", "b", "1.0.0", {});

        const m = manager();
        (await m.acquire("a")).release();
        (await m.acquire("b")).release();

        await m.shutdown();

        expect(m.liveCount).toBe(0);
        expect(a.controls.countOf("dispose")).toBe(1);
        expect(b.controls.countOf("dispose")).toBe(1);
    });

    it("refuses new acquires once shutting down", async () => {
        register("a", async () => makeFakeConnector());
        const m = manager();
        await m.shutdown();
        await expect(m.acquire("a")).rejects.toThrow(/shutting down/);
    });

    it("is idempotent", async () => {
        const c = makeFakeConnector();
        register("a", async () => c);
        const m = manager();
        (await m.acquire("a")).release();

        await m.shutdown();
        await m.shutdown();

        expect(c.controls.countOf("dispose")).toBe(1);
    });

    it("stops the sweep timer", async () => {
        const m = manager({ sweepIntervalMs: 10 });
        m.start();
        const cleared = vi.spyOn(globalThis, "clearInterval");
        await m.shutdown();
        expect(cleared).toHaveBeenCalled();
        cleared.mockRestore();
    });
});

describe("registry interaction", () => {
    it("leaves websocket-style eager registration working", async () => {
        // initInstance must keep building immediately: the websocket service
        // reads `.impl` straight off the returned instance.
        registry.registerFactory("eager", "1.0.0", async () => makeFakeConnector());
        const inst = await registry.initInstance("e1", "eager", "1.0.0", {});

        expect(inst.impl).toBeDefined();
        expect(registry.isMaterialized("e1")).toBe(true);
        expect(registry.get("e1").impl).toBe(inst.impl);
    });

    it("rejects a duplicate id whether the first was registered or built", async () => {
        registry.registerFactory("fake", "1.0.0", async () => makeFakeConnector());

        registry.registerInstance("dup", "fake", "1.0.0", {});
        expect(() => registry.registerInstance("dup", "fake", "1.0.0", {}))
            .toThrow(/already registered/);
        await expect(registry.initInstance("dup", "fake", "1.0.0", {}))
            .rejects.toThrow(/already registered/);
    });

    it("frees the id after a failed eager init", async () => {
        registry.registerFactory("bad", "1.0.0", async () => { throw new Error("nope"); });
        await expect(registry.initInstance("x", "bad", "1.0.0", {})).rejects.toThrow("nope");

        // The caller saw the failure and will retry; a lingering definition
        // would make that retry fail for the wrong reason.
        expect(registry.getDefinition("x")).toBeUndefined();
    });

    it("releases the id on disposeInstance even if never built", async () => {
        registry.registerFactory("fake", "1.0.0", async () => makeFakeConnector());
        registry.registerInstance("lazy", "fake", "1.0.0", {});

        await registry.disposeInstance("lazy");

        expect(registry.getDefinition("lazy")).toBeUndefined();
        expect(() => registry.registerInstance("lazy", "fake", "1.0.0", {})).not.toThrow();
    });

    it("validates runtime config at registration, before any factory runs", async () => {
        let built = 0;
        registry.registerFactory("fake", "1.0.0", async () => { built++; return makeFakeConnector(); });

        expect(() => registry.registerInstance("bad", "fake", "1.0.0", {}, { attemptDeadlineMs: -1 }))
            .toThrow(/Unlimited \(-1\) is rejected/);
        expect(built).toBe(0);
    });

    it("exposes resolved runtime config on the materialized instance", async () => {
        registry.registerFactory("fake", "1.0.0", async () => makeFakeConnector());
        registry.registerInstance("tuned", "fake", "1.0.0", {}, { mutationConcurrency: 4 });

        const inst = await registry.materializeInstance("tuned");
        expect(inst.runtime.mutationConcurrency).toBe(4);
        expect(inst.runtime.interactiveSlots).toBe(1);
    });

    it("shares one build between concurrent materialize calls", async () => {
        let built = 0;
        const gate = deferred<void>();
        registry.registerFactory("fake", "1.0.0", async () => {
            built++;
            await gate.promise;
            return makeFakeConnector();
        });
        registry.registerInstance("shared", "fake", "1.0.0", {});

        const both = Promise.all([
            registry.materializeInstance("shared"),
            registry.materializeInstance("shared"),
        ]);
        await flushMicrotasks();
        gate.resolve();

        const [a, b] = await both;
        expect(built).toBe(1);
        expect(a).toBe(b);
    });
});
