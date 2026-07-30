import { describe, it, expect } from "vitest";
import { ConnectorRegistry } from "../src/registry/ConnectorRegistry.js";
import { redactSecrets } from "../src/registry/redact.js";
import { GuardedString } from "../src/spi/GuardedString.js";
import type { ConnectorSpi } from "../src/spi/types.js";

async function load(registry: ConnectorRegistry, id: string, config: Record<string, unknown>) {
    registry.registerFactory(id, "1.0.0", async () => ({}) as ConnectorSpi);
    await registry.initInstance(id, id, "1.0.0", config);
}

describe("registry list() redaction", () => {
    it("masks secret-looking keys while preserving the rest", async () => {
        const registry = new ConnectorRegistry();
        await load(registry, "c1", {
            password: "hunter2",
            clientSecret: "sh-abc",
            apiKey: "ak-123",
            host: "db.internal",
            port: 5432,
        });

        const listed = registry.list()[0]!.config as any;

        expect(listed.password).toBe("***");
        expect(listed.clientSecret).toBe("***");
        expect(listed.apiKey).toBe("***");
        expect(listed.host).toBe("db.internal");
        expect(listed.port).toBe(5432);
    });

    it("leaves get() unredacted, because operations need the real config", async () => {
        const registry = new ConnectorRegistry();
        await load(registry, "c2", { password: "hunter2", host: "h" });

        expect((registry.get("c2").config as any).password).toBe("hunter2");
        expect((registry.getSpi("c2"))).toBeDefined();
    });

    it("does not mutate the stored config", async () => {
        const registry = new ConnectorRegistry();
        await load(registry, "c3", { password: "hunter2" });

        registry.list();
        registry.list();

        expect((registry.get("c3").config as any).password).toBe("hunter2");
    });

    it("masks a GuardedString under an innocent key", async () => {
        const registry = new ConnectorRegistry();
        await load(registry, "c4", { credential: new GuardedString("s3cr3t"), host: "h" });

        const listed = registry.list()[0]!.config as any;

        // "credential" does not match the key pattern; the instance check is
        // what covers it.
        expect(listed.credential).toBe("***");
        expect(listed.host).toBe("h");
        expect(JSON.stringify(listed)).not.toContain("s3cr3t");
    });
});

describe("redactSecrets", () => {
    it("walks nested objects and arrays", () => {
        const out: any = redactSecrets({
            outer: {
                password: "p",
                nested: [{ apiKey: "k", name: "keep" }, { plain: "keep too" }],
            },
            list: ["a", "b"],
        });

        expect(out.outer.password).toBe("***");
        expect(out.outer.nested[0].apiKey).toBe("***");
        expect(out.outer.nested[0].name).toBe("keep");
        expect(out.outer.nested[1].plain).toBe("keep too");
        expect(out.list).toEqual(["a", "b"]);
    });

    it("masks GuardedString anywhere in the tree", () => {
        const out: any = redactSecrets({ a: { b: [new GuardedString("deep-secret")] } });
        expect(out.a.b[0]).toBe("***");
        expect(JSON.stringify(out)).not.toContain("deep-secret");
    });

    it("over-matches on purpose, and that is documented", () => {
        const out: any = redactSecrets({ tokenUrl: "https://idp/token", publicKeyPath: "/etc/pub.pem" });

        // Not secrets, but masked because the pattern is deliberately broad.
        // For a listing API this is the right direction to err; get() is the
        // escape hatch.
        expect(out.tokenUrl).toBe("***");
        expect(out.publicKeyPath).toBe("***");
    });

    it("passes primitives through", () => {
        expect(redactSecrets("plain")).toBe("plain");
        expect(redactSecrets(42)).toBe(42);
        expect(redactSecrets(null)).toBe(null);
        expect(redactSecrets(undefined)).toBe(undefined);
    });
});
