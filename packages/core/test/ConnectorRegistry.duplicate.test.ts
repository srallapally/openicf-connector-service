import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConnectorRegistry } from "../src/registry/ConnectorRegistry.js";
import { loadExternalConnectors } from "../src/loader/ExternalLoader.js";

const tempDirs: string[] = [];

/**
 * Write a connector directory the external loader can read: a manifest plus an
 * ESM entry module whose default export is the factory.
 */
async function writeConnectorDir(
    root: string,
    dirName: string,
    manifest: Record<string, unknown>,
) {
    const dir = path.join(root, dirName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
        path.join(dir, "index.mjs"),
        `export default async (ctx) => ({ marker: ${JSON.stringify(dirName)}, ctx });\n`,
    );
    await fs.writeFile(
        path.join(dir, "manifest.json"),
        JSON.stringify({ entry: "index.mjs", ...manifest }, null, 2),
    );
    return dir;
}

async function makeTempRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openicf-loader-"));
    tempDirs.push(root);
    return root;
}

describe("ConnectorRegistry duplicate instance ids", () => {
    afterEach(async () => {
        vi.restoreAllMocks();
        while (tempDirs.length) {
            await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
        }
    });

    it("rejects a second initInstance for an id already registered", async () => {
        const registry = new ConnectorRegistry();
        registry.registerFactory("alpha", "1.0.0", async () => ({ tag: "first" }) as any);
        registry.registerFactory("beta", "2.1.0", async () => ({ tag: "second" }) as any);

        await registry.initInstance("x", "alpha", "1.0.0", { n: 1 });

        await expect(
            registry.initInstance("x", "beta", "2.1.0", { n: 2 }),
        ).rejects.toThrow(/already registered/);

        // Message must name the id and both connector keys so the operator can
        // see what is colliding with what.
        await expect(
            registry.initInstance("x", "beta", "2.1.0", { n: 2 }),
        ).rejects.toThrow(/'x'/);
        await expect(
            registry.initInstance("x", "beta", "2.1.0", { n: 2 }),
        ).rejects.toThrow(/alpha@1\.0\.0/);
        await expect(
            registry.initInstance("x", "beta", "2.1.0", { n: 2 }),
        ).rejects.toThrow(/beta@2\.1\.0/);
    });

    it("leaves the first instance untouched after a rejected duplicate", async () => {
        const registry = new ConnectorRegistry();
        registry.registerFactory("alpha", "1.0.0", async () => ({ tag: "first" }) as any);
        registry.registerFactory("beta", "2.1.0", async () => ({ tag: "second" }) as any);

        await registry.initInstance("x", "alpha", "1.0.0", { n: 1 });
        await expect(registry.initInstance("x", "beta", "2.1.0", { n: 2 })).rejects.toThrow();

        const inst = registry.get("x");
        expect((inst.impl as any).tag).toBe("first");
        expect(inst.config).toEqual({ n: 1 });
        expect(inst.connectorKey).toEqual({ type: "alpha", version: "1.0.0" });
    });

    it("detects duplicates by id, not by connector key", async () => {
        const registry = new ConnectorRegistry();
        registry.registerFactory("alpha", "1.0.0", async () => ({ tag: "t" }) as any);

        await registry.initInstance("one", "alpha", "1.0.0", {});
        await registry.initInstance("two", "alpha", "1.0.0", {});

        expect(registry.ids().sort()).toEqual(["one", "two"]);
    });

    it("does not run the config builder for a rejected duplicate", async () => {
        const registry = new ConnectorRegistry();
        const builder = vi.fn(async (raw: any) => raw);
        registry.registerFactory("alpha", "1.0.0", async () => ({ tag: "first" }) as any);
        registry.registerFactory("beta", "2.1.0", async () => ({ tag: "second" }) as any);
        registry.registerConfigBuilder("beta", "2.1.0", builder);

        await registry.initInstance("x", "alpha", "1.0.0", {});
        await expect(registry.initInstance("x", "beta", "2.1.0", {})).rejects.toThrow();

        // The guard must precede config construction, so a rejected duplicate
        // never executes the new config's side effects.
        expect(builder).not.toHaveBeenCalled();
    });

    it("supports dispose-then-init as the replacement path", async () => {
        const registry = new ConnectorRegistry();
        const dispose = vi.fn(async () => undefined);
        registry.registerFactory("alpha", "1.0.0", async () => ({ tag: "first", dispose }) as any);
        registry.registerFactory("beta", "2.1.0", async () => ({ tag: "second" }) as any);

        await registry.initInstance("x", "alpha", "1.0.0", {});
        await registry.disposeInstance("x");
        await registry.initInstance("x", "beta", "2.1.0", {});

        expect(dispose).toHaveBeenCalledTimes(1);
        expect((registry.get("x").impl as any).tag).toBe("second");
    });

    it("loader: a duplicate id across manifests fails that connector only", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const root = await makeTempRoot();
        await writeConnectorDir(root, "a-first", {
            id: "a-first", type: "a-first", version: "1.0.0",
            instances: [{ id: "shared" }],
        });
        await writeConnectorDir(root, "b-collides", {
            id: "b-collides", type: "b-collides", version: "1.0.0",
            instances: [{ id: "shared" }],
        });
        await writeConnectorDir(root, "c-ok", {
            id: "c-ok", type: "c-ok", version: "1.0.0",
            instances: [{ id: "unrelated" }],
        });

        const registry = new ConnectorRegistry();
        await loadExternalConnectors(root, registry);

        // First wins; the colliding directory is reported; unrelated ones load.
        expect(registry.ids().sort()).toEqual(["shared", "unrelated"]);
        expect((registry.get("shared").impl as any).marker).toBe("a-first");

        const logged = errorSpy.mock.calls.map(c => String(c[0])).join("\n");
        expect(logged).toContain("[external] failed to load b-collides");
        expect(logged).toContain("already registered");
    });

    it("loader: duplicate ids within one manifest skip that connector's remaining instances", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const root = await makeTempRoot();
        await writeConnectorDir(root, "dup", {
            id: "dup", type: "dup", version: "1.0.0",
            instances: [{ id: "x" }, { id: "x" }, { id: "y" }],
        });

        const registry = new ConnectorRegistry();
        await loadExternalConnectors(root, registry);

        // Chosen behaviour, not accidental: the loader's try/catch wraps the
        // whole directory, so throwing on the second "x" abandons the rest of
        // this connector and "y" never registers. A manifest with duplicate
        // instance ids is malformed; a partial load with a loud error is
        // preferred over silently overwriting "x".
        expect(registry.ids()).toEqual(["x"]);
        expect(registry.has("y")).toBe(false);
        expect(errorSpy.mock.calls.map(c => String(c[0])).join("\n"))
            .toContain("[external] failed to load dup");
    });
});
