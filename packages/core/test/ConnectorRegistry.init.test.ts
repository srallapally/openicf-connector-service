import { describe, it, expect, vi } from "vitest";
import { ConnectorRegistry } from "../src/registry/ConnectorRegistry.js";

/**
 * Ported from the legacy root-level test/framework/connector-registry.test.ts,
 * which sat outside every workspace and imported src/core/ConnectorRegistry.js
 * -- a path removed in the packages split -- so it never ran.
 *
 * These two assertions had no equivalent in packages/core: the factory and
 * config-builder invocation contract, and semver ordering of registered
 * versions. The legacy file mocked semver; core declares it as a real
 * dependency now, so the mock is dropped and the real comparator is exercised.
 */
describe("ConnectorRegistry initialization", () => {
    it("initializes connectors using registered factories and builders", async () => {
        const registry = new ConnectorRegistry();
        const spi = { test: vi.fn() };
        const validate = vi.fn(async () => undefined);
        const builder = vi.fn(async () => ({ validate }));
        const factory = vi.fn(async (config: any) => {
            expect(config).toMatchObject({
                instanceId: "alpha",
                connectorId: "example",
                connectorVersion: "1.0.0",
                type: "example",
            });
            return spi as any;
        });

        registry.registerFactory("example", "1.0.0", factory);
        registry.registerConfigBuilder("example", "1.0.0", builder);

        const instance = await registry.initInstance("alpha", "example", "1.0.0", { foo: "bar" } as any);

        expect(builder).toHaveBeenCalledWith({ foo: "bar" });
        expect(validate).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(instance.impl).toBe(spi);
        expect(registry.get("alpha")).toBe(instance);
        expect(registry.has("alpha")).toBe(true);
        expect(Array.from(registry.keys())).toEqual(["alpha"]);
        expect(registry.ids()).toEqual(["alpha"]);
    });

    it("returns a redacted copy from list(), not the stored instance", async () => {
        // Divergence from the legacy assertion `expect(registry.list()).toEqual([instance])`:
        // list() now returns instances whose config is a redacted copy, so the
        // entry is no longer the same object. get() still yields the original.
        const registry = new ConnectorRegistry();
        registry.registerFactory("example", "1.0.0", async () => ({}) as any);
        const instance = await registry.initInstance("alpha", "example", "1.0.0", { password: "p", host: "h" } as any);

        const listed = registry.list();

        expect(listed).toHaveLength(1);
        expect(listed[0]!.id).toBe("alpha");
        expect(listed[0]).not.toBe(instance);
        expect((listed[0]!.config as any).password).toBe("***");
        expect((registry.get("alpha").config as any).password).toBe("p");
    });

    it("sorts registered versions using semantic version precedence", () => {
        const registry = new ConnectorRegistry();
        const factory = vi.fn(async () => ({}) as any);

        registry.registerFactory("example", "1.0.0", factory);
        registry.registerFactory("example", "1.0.0-beta.1", factory);
        registry.registerFactory("example", "2.0.0", factory);
        registry.registerFactory("example", "1.10.0", factory);

        expect(registry.getVersions("example")).toEqual([
            "1.0.0-beta.1",
            "1.0.0",
            "1.10.0",
            "2.0.0",
        ]);
        expect(registry.getLatestVersion("example")).toBe("2.0.0");
    });
});
