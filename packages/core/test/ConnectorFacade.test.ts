import { describe, it, expect, vi } from "vitest";
import { ConnectorFacade } from "../src/registry/ConnectorFacade.js";
import { resolveRuntimeConfig } from "../src/config/runtime.js";

/**
 * Minimal SPI stub. `src` identifies which connector produced the object, so a
 * leak between facades is visible in the returned payload.
 */
function makeImpl(src: string) {
    return {
        get: vi.fn(async (_objectClass: string, uid: string) => ({
            uid,
            attributes: { src },
        })),
        update: vi.fn(async (_objectClass: string, uid: string) => ({ uid })),
    };
}

const cached = (ttlMs = 30_000, max = 100) =>
    ({ runtime: resolveRuntimeConfig({ readCache: { ttlMs, max } }) });

describe("ConnectorFacade read cache is opt-in", () => {
    it("does not cache get by default", async () => {
        // CP-1 rejected default read caching outright: the invalidation scan
        // cost more than the cache saved, every facade paid for the allocation
        // whether or not it cached anything, and cross-replica stale
        // read-after-write was unfixable.
        const impl = makeImpl("A");
        const facade = new ConnectorFacade(impl, "a");

        await facade.get("account", "42");
        await facade.get("account", "42");

        expect(impl.get).toHaveBeenCalledTimes(2);
    });

    it("caches get when readCache is configured", async () => {
        const impl = makeImpl("A");
        const facade = new ConnectorFacade(impl, "a", cached());

        await facade.get("account", "42");
        await facade.get("account", "42");

        expect(impl.get).toHaveBeenCalledTimes(1);
    });

    it("keys the cache by uid and requested attributes", async () => {
        const impl = makeImpl("A");
        const facade = new ConnectorFacade(impl, "a", cached());

        await facade.get("account", "42");
        await facade.get("account", "43");
        await facade.get("account", "42", { attributesToGet: ["mail"] });

        expect(impl.get).toHaveBeenCalledTimes(3);
    });

    it("expires entries on TTL alone", async () => {
        // Real timers with a tiny TTL: lru-cache captures its clock reference
        // at import, so fake timers installed later never reach it.
        const impl = makeImpl("A");
        const facade = new ConnectorFacade(impl, "a", cached(10));

        await facade.get("account", "42");
        await facade.get("account", "42");
        expect(impl.get).toHaveBeenCalledTimes(1);

        await new Promise(r => setTimeout(r, 25));

        await facade.get("account", "42");
        expect(impl.get).toHaveBeenCalledTimes(2);
    });

    it("bounds the cache at the configured size", async () => {
        const impl = makeImpl("A");
        const facade = new ConnectorFacade(impl, "a", cached(30_000, 2));

        await facade.get("account", "1");
        await facade.get("account", "2");
        await facade.get("account", "3");   // evicts uid 1
        expect(impl.get).toHaveBeenCalledTimes(3);

        await facade.get("account", "1");   // gone, refetched
        expect(impl.get).toHaveBeenCalledTimes(4);
        await facade.get("account", "3");   // still resident
        expect(impl.get).toHaveBeenCalledTimes(4);
    });

    it("does not invalidate on write", async () => {
        // Deliberate: TTL only. The prefix scan this replaces was measured at
        // 2.45ms per write and could not be correct across replicas anyway.
        const impl = makeImpl("A");
        const facade = new ConnectorFacade(impl, "a", cached());

        await facade.get("account", "42");
        await facade.update("account", "42", { attributes: { src: "A2" } });
        await facade.get("account", "42");

        expect(impl.get).toHaveBeenCalledTimes(1);
    });

    it("does not serve one connector's cached object to another", async () => {
        const implA = makeImpl("A");
        const implB = makeImpl("B");
        const fa = new ConnectorFacade(implA, "a", cached());
        const fb = new ConnectorFacade(implB, "b", cached());

        const ra: any = await fa.get("account", "42");
        const rb: any = await fb.get("account", "42");

        expect(ra.attributes.src).toBe("A");
        expect(rb.attributes.src).toBe("B");
        expect(implB.get).toHaveBeenCalledTimes(1);
    });

    it("gives each facade its own cache, even for the same impl and id", async () => {
        const impl = makeImpl("A");
        const f1 = new ConnectorFacade(impl, "same", cached());
        const f2 = new ConnectorFacade(impl, "same", cached());

        await f1.get("account", "42");
        expect(impl.get).toHaveBeenCalledTimes(1);

        await f2.get("account", "42");
        expect(impl.get).toHaveBeenCalledTimes(2);
    });

    it("still caches schema, which is static per connector version", async () => {
        const impl = { schema: vi.fn(async () => ({ objectClasses: [] })) };
        const facade = new ConnectorFacade(impl, "a");

        await facade.schema();
        await facade.schema();

        expect(impl.schema).toHaveBeenCalledTimes(1);
    });
});
