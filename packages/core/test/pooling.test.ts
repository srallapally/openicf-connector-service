import { describe, it, expect, beforeEach } from "vitest";
import { ConnectorRegistry } from "../src/registry/ConnectorRegistry.js";
import { ConnectorManager } from "../src/registry/ConnectorManager.js";
import { makeFakeConnector, FakeTarget, type FakeConnector } from "../src/testing/FakeConnector.js";
import { deferred } from "../src/testing/async.js";

const OC = "__ACCOUNT__";

let registry: ConnectorRegistry;
let manager: ConnectorManager;
let built: FakeConnector[];
let target: FakeTarget;

/**
 * Register one instance whose factory mints a distinct connector each call,
 * all sharing a single target -- which is what a real pool of connections to
 * one directory looks like.
 */
function setup(opts: { poolable: boolean; mutationConcurrency?: number; readConcurrency?: number }): void {
    registry = new ConnectorRegistry();
    built = [];
    target = new FakeTarget();

    registry.registerFactory("ldap", "1.0.0", async () => {
        const c = makeFakeConnector({ target });
        built.push(c);
        return c;
    });
    registry.registerCapabilities("ldap", "1.0.0", { poolable: opts.poolable });
    registry.registerInstance("dir", "ldap", "1.0.0", {}, {
        mutationConcurrency: opts.mutationConcurrency ?? 4,
        readConcurrency: opts.readConcurrency ?? 4,
    });

    manager = new ConnectorManager(registry, { logger: { error: () => {} } });
}

/** Which distinct connector objects actually served an operation. */
function serving(): FakeConnector[] {
    return built.filter(c => c.controls.calls.some(x => x.op === "create"));
}

beforeEach(() => { built = []; });

describe("poolable connectors", () => {
    it("serves concurrent operations from distinct SPI instances", async () => {
        // The point of pooling a stateful protocol: concurrency means more
        // connections, not more requests multiplexed down one.
        setup({ poolable: true, mutationConcurrency: 4, readConcurrency: 0 || 4 });
        const lease = await manager.acquire("dir");

        const gate = deferred<void>();
        for (const c of built) c.controls.latency(0);

        // Hold four creates open at once by making each wait on the gate.
        const originals = new Map<FakeConnector, any>();
        const wrap = (c: FakeConnector) => {
            if (originals.has(c)) return;
            const real = c.create!.bind(c);
            originals.set(c, real);
            (c as any).create = async (...args: any[]) => {
                await gate.promise;
                return real(...(args as [any, any, any]));
            };
        };

        // New pool resources appear as they are created, so wrap on demand.
        const wrapAll = setInterval(() => built.forEach(wrap), 1);

        const calls = Array.from({ length: 4 }, (_, i) =>
            lease.facade.create(OC, { __NAME__: `u${i}` }));

        await new Promise(r => setTimeout(r, 20));
        gate.resolve();
        await Promise.all(calls);
        clearInterval(wrapAll);

        expect(serving().length).toBeGreaterThan(1);
        expect(target.size).toBe(4);

        lease.release();
        await manager.shutdown();
    });

    it("caps live connections at the summed concurrency budgets", async () => {
        setup({ poolable: true, mutationConcurrency: 2, readConcurrency: 1 });
        const lease = await manager.acquire("dir");

        // Issued two at a time: the facade's breaker sheds anything past the
        // mutation budget, exactly as it would in production where the
        // dispatcher never oversubscribes an instance.
        for (let batch = 0; batch < 6; batch++) {
            await Promise.all([
                lease.facade.create(OC, { __NAME__: `n${batch}a` }),
                lease.facade.create(OC, { __NAME__: `n${batch}b` }),
            ]);
        }

        // Pool max is mutation + read = 3, so the factory can never have been
        // asked for more than that.
        expect(built.length).toBeLessThanOrEqual(3);
        expect(target.size).toBe(12);

        lease.release();
        await manager.shutdown();
    });

    it("reuses connections rather than opening one per call", async () => {
        setup({ poolable: true });
        const lease = await manager.acquire("dir");

        for (let i = 0; i < 10; i++) {
            await lease.facade.create(OC, { __NAME__: `seq${i}` });
        }

        // Serialized calls should recycle a single connection.
        expect(built.length).toBeLessThanOrEqual(2);
        expect(target.size).toBe(10);

        lease.release();
        await manager.shutdown();
    });

    it("drains every pooled connection on shutdown", async () => {
        setup({ poolable: true });
        const lease = await manager.acquire("dir");

        await Promise.all(
            Array.from({ length: 3 }, (_, i) => lease.facade.create(OC, { __NAME__: `d${i}` })),
        );
        lease.release();

        await manager.shutdown();

        // Every connector the factory produced was disposed, not just one.
        const disposed = built.filter(c => c.controls.countOf("dispose") > 0);
        expect(disposed.length).toBe(built.length);
        expect(built.length).toBeGreaterThan(0);
    });

    it("drains the pool on idle eviction too", async () => {
        setup({ poolable: true });
        let t = 1_000_000;
        manager = new ConnectorManager(registry, {
            idleTtlMs: 100,
            now: () => t,
            logger: { error: () => {} },
        });

        const lease = await manager.acquire("dir");
        await lease.facade.create(OC, { __NAME__: "x" });
        lease.release();

        t += 1_000;
        await manager.sweep();

        expect(manager.liveCount).toBe(0);
        expect(built.every(c => c.controls.countOf("dispose") > 0)).toBe(true);
    });

    it("exposes streaming capability through the pool", async () => {
        // Flags are data, not behaviour, so the proxy has to carry them or the
        // facade misroutes every search.
        registry = new ConnectorRegistry();
        built = [];
        target = new FakeTarget();
        registry.registerFactory("ldap", "1.0.0", async () => {
            const c = makeFakeConnector({ target, searchStreaming: true });
            built.push(c);
            return c;
        });
        registry.registerCapabilities("ldap", "1.0.0", { poolable: true });
        registry.registerInstance("dir", "ldap", "1.0.0", {});
        manager = new ConnectorManager(registry, { logger: { error: () => {} } });

        const lease = await manager.acquire("dir");
        await lease.facade.create(OC, { __NAME__: "a" });
        await lease.facade.create(OC, { __NAME__: "b" });

        const seen: string[] = [];
        await lease.facade.search(OC, null, (o: any) => {
            seen.push(String(o.attributes.__NAME__));
            return true;
        });

        expect(seen.sort()).toEqual(["a", "b"]);

        lease.release();
        await manager.shutdown();
    });
});

describe("non-poolable connectors", () => {
    it("uses a single instance", async () => {
        setup({ poolable: false, mutationConcurrency: 8 });
        const lease = await manager.acquire("dir");

        await Promise.all(
            Array.from({ length: 5 }, (_, i) => lease.facade.create(OC, { __NAME__: `s${i}` })),
        );

        expect(built).toHaveLength(1);
        expect(target.size).toBe(5);

        lease.release();
        await manager.shutdown();
    });

    it("disposes that single instance on shutdown", async () => {
        setup({ poolable: false });
        const lease = await manager.acquire("dir");
        await lease.facade.create(OC, { __NAME__: "one" });
        lease.release();

        await manager.shutdown();

        expect(built[0]!.controls.countOf("dispose")).toBe(1);
    });
});
