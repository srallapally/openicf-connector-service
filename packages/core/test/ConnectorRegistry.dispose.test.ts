import { describe, it, expect, vi, afterEach } from "vitest";
import { ConnectorRegistry } from "../src/registry/ConnectorRegistry.js";
import type { ConnectorSpi } from "../src/spi/types.js";

/** Register a factory returning `impl` and instantiate it under `id`. */
async function loadInstance(registry: ConnectorRegistry, id: string, impl: ConnectorSpi) {
    registry.registerFactory(id, "1.0.0", async () => impl);
    await registry.initInstance(id, id, "1.0.0", {});
}

describe("ConnectorRegistry disposal", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("awaits dispose once and drops the instance", async () => {
        const registry = new ConnectorRegistry();
        const impl = { dispose: vi.fn(async () => undefined) };
        await loadInstance(registry, "a", impl);
        expect(registry.has("a")).toBe(true);

        await registry.disposeInstance("a");

        expect(impl.dispose).toHaveBeenCalledTimes(1);
        expect(registry.has("a")).toBe(false);
    });

    it("removes a connector with no dispose method, without throwing", async () => {
        const registry = new ConnectorRegistry();
        await loadInstance(registry, "b", {});

        await expect(registry.disposeInstance("b")).resolves.toBeUndefined();
        expect(registry.has("b")).toBe(false);
    });

    it("logs and still removes the instance when dispose rejects", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const registry = new ConnectorRegistry();
        const impl = { dispose: vi.fn(async () => { throw new Error("teardown blew up"); }) };
        await loadInstance(registry, "c", impl);

        // Never throws: the rejection is absorbed and reported.
        await expect(registry.disposeInstance("c")).resolves.toBeUndefined();

        expect(registry.has("c")).toBe(false);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const logged = String(errorSpy.mock.calls[0]![0]);
        expect(logged).toContain("c");
        expect(logged).toContain("teardown blew up");
    });

    it("keeps disposing after one connector fails", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const registry = new ConnectorRegistry();
        const failing = { dispose: vi.fn(async () => { throw new Error("boom"); }) };
        const healthy = { dispose: vi.fn(async () => undefined) };
        await loadInstance(registry, "first", failing);
        await loadInstance(registry, "second", healthy);

        await registry.disposeAll();

        expect(failing.dispose).toHaveBeenCalledTimes(1);
        expect(healthy.dispose).toHaveBeenCalledTimes(1);
        expect(registry.has("first")).toBe(false);
        expect(registry.has("second")).toBe(false);
        expect(registry.ids()).toEqual([]);
    });

    it("disposeAll twice disposes each instance exactly once", async () => {
        const registry = new ConnectorRegistry();
        const one = { dispose: vi.fn(async () => undefined) };
        const two = { dispose: vi.fn(async () => undefined) };
        await loadInstance(registry, "one", one);
        await loadInstance(registry, "two", two);

        await registry.disposeAll();
        await registry.disposeAll();

        // Idempotent at the registry layer: removal-always empties the map, so
        // the second pass has nothing to iterate.
        expect(one.dispose).toHaveBeenCalledTimes(1);
        expect(two.dispose).toHaveBeenCalledTimes(1);
        expect(registry.ids()).toEqual([]);
    });

    it("is a silent no-op for an id that was never registered", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const registry = new ConnectorRegistry();

        await expect(registry.disposeInstance("never-registered")).resolves.toBeUndefined();
        expect(errorSpy).not.toHaveBeenCalled();
    });
});
