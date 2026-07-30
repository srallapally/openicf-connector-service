import { describe, it, expect, vi } from "vitest";
import { ConnectorFacade } from "../src/registry/ConnectorFacade.js";

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

describe("ConnectorFacade result cache isolation", () => {
    it("does not serve one connector's cached object to another", async () => {
        // Same objectClass and uid on both connectors: the collision case.
        const implA = makeImpl("A");
        const implB = makeImpl("B");
        const fa = new ConnectorFacade(implA, "a");
        const fb = new ConnectorFacade(implB, "b");

        const ra = await fa.get("account", "42");
        const rb = await fb.get("account", "42");

        expect(ra.attributes.src).toBe("A");
        expect(rb.attributes.src).toBe("B");

        // B must actually be consulted rather than answered from A's entry.
        expect(implB.get).toHaveBeenCalledTimes(1);
    });

    it("invalidating one connector's cache leaves another's intact", async () => {
        const implA = makeImpl("A");
        const implB = makeImpl("B");
        const fa = new ConnectorFacade(implA, "a");
        const fb = new ConnectorFacade(implB, "b");

        await fa.get("account", "42");
        await fb.get("account", "42");
        expect(implA.get).toHaveBeenCalledTimes(1);
        expect(implB.get).toHaveBeenCalledTimes(1);

        // Write through A: only A's entry for this uid should be dropped.
        await fa.update("account", "42", { attributes: { src: "A2" } });

        await fa.get("account", "42");
        expect(implA.get).toHaveBeenCalledTimes(2);

        await fb.get("account", "42");
        expect(implB.get).toHaveBeenCalledTimes(1);
    });

    it("gives each facade its own cache, even for the same impl and id", async () => {
        // Deliberate behavioural choice: the cache belongs to the facade
        // instance, not to the connector id. Two facades over one connector do
        // not share entries. Callers that want sharing must reuse the facade,
        // which is what ConnectorRegistry/RemoteConnectorService already do.
        const impl = makeImpl("A");
        const f1 = new ConnectorFacade(impl, "same");
        const f2 = new ConnectorFacade(impl, "same");

        await f1.get("account", "42");
        expect(impl.get).toHaveBeenCalledTimes(1);

        await f2.get("account", "42");
        expect(impl.get).toHaveBeenCalledTimes(2);
    });
});
