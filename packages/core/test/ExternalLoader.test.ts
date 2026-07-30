import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConnectorRegistry } from "../src/registry/ConnectorRegistry.js";
import { loadExternalConnectors } from "../src/loader/ExternalLoader.js";

const tempRoots: string[] = [];

async function makeRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openicf-bootstrap-"));
    tempRoots.push(root);
    return root;
}

/** Write a connector directory: manifest, ESM entry, and optionally instances.json. */
async function writeConnector(
    root: string,
    name: string,
    manifest: Record<string, unknown>,
    instancesJson?: string,
) {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
        path.join(dir, "index.mjs"),
        `export default async (ctx) => ({ marker: ${JSON.stringify(name)}, cfg: ctx.config });\n`,
    );
    await fs.writeFile(
        path.join(dir, "manifest.json"),
        JSON.stringify({ entry: "index.mjs", id: name, type: name, version: "1.0.0", ...manifest }),
    );
    if (instancesJson !== undefined) {
        await fs.writeFile(path.join(dir, "instances.json"), instancesJson);
    }
    return dir;
}

function quietConsole() {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    return {
        error,
        warn,
        errors: () => error.mock.calls.map((c) => String(c[0])).join("\n"),
        warnings: () => warn.mock.calls.map((c) => String(c[0])).join("\n"),
    };
}

afterEach(async () => {
    vi.restoreAllMocks();
    while (tempRoots.length) {
        await fs.rm(tempRoots.pop()!, { recursive: true, force: true });
    }
    delete process.env.BOOTSTRAP_TEST_SECRET;
});

describe("instances.json bootstrap", () => {
    it("registers instances from instances.json when the manifest declares none", async () => {
        quietConsole();
        const root = await makeRoot();
        await writeConnector(root, "from-file", {}, JSON.stringify([{ id: "inst-a", config: { host: "h" } }]));

        const registry = new ConnectorRegistry();
        await loadExternalConnectors(root, registry);

        expect(registry.ids()).toEqual(["inst-a"]);
        expect((registry.get("inst-a").config as any).host).toBe("h");
    });

    it("prefers manifest.instances and does not merge instances.json", async () => {
        quietConsole();
        const root = await makeRoot();
        await writeConnector(
            root,
            "both",
            { instances: [{ id: "from-manifest", config: { src: "manifest" } }] },
            JSON.stringify([{ id: "from-file", config: { src: "file" } }]),
        );

        const registry = new ConnectorRegistry();
        await loadExternalConnectors(root, registry);

        // No merge: a silent union is where duplicate-id surprises come from.
        expect(registry.ids()).toEqual(["from-manifest"]);
        expect(registry.has("from-file")).toBe(false);
    });

    it("contains a malformed instances.json to its own connector", async () => {
        const spies = quietConsole();
        const root = await makeRoot();
        await writeConnector(root, "broken", {}, "{ not valid json");
        await writeConnector(root, "healthy", {}, JSON.stringify([{ id: "ok-inst" }]));

        const registry = new ConnectorRegistry();
        await loadExternalConnectors(root, registry);

        // The bad file is reported by name...
        expect(spies.errors()).toContain("broken");
        expect(spies.errors()).toContain("invalid instances.json");
        // ...its factory is still registered, and the other connector is intact.
        expect(registry.getVersions("broken")).toEqual(["1.0.0"]);
        expect(registry.ids()).toEqual(["ok-inst"]);
    });

    it("stays silent when instances.json is simply absent", async () => {
        const spies = quietConsole();
        const root = await makeRoot();
        await writeConnector(root, "none", {});

        const registry = new ConnectorRegistry();
        await loadExternalConnectors(root, registry);

        // Absent file is a normal choice, not an error.
        expect(spies.errors()).not.toContain("instances.json");
        expect(spies.warnings()).toContain("no instances defined");
        expect(registry.ids()).toEqual([]);
    });

    it("applies ${ENV} substitution to file-sourced config", async () => {
        quietConsole();
        process.env.BOOTSTRAP_TEST_SECRET = "resolved-value";
        const root = await makeRoot();
        await writeConnector(
            root,
            "envsub",
            {},
            JSON.stringify([{ id: "env-inst", config: { token: "${BOOTSTRAP_TEST_SECRET}" } }]),
        );

        const registry = new ConnectorRegistry();
        await loadExternalConnectors(root, registry);

        expect((registry.get("env-inst").config as any).token).toBe("resolved-value");
    });

    it("fails only the affected connector when an ${ENV} var is missing", async () => {
        const spies = quietConsole();
        const root = await makeRoot();
        await writeConnector(
            root,
            "missing-env",
            {},
            JSON.stringify([{ id: "bad-env", config: { token: "${DEFINITELY_NOT_SET_VAR}" } }]),
        );
        await writeConnector(root, "fine", {}, JSON.stringify([{ id: "fine-inst" }]));

        const registry = new ConnectorRegistry();
        await loadExternalConnectors(root, registry);

        expect(spies.errors()).toContain("missing-env");
        expect(registry.ids()).toEqual(["fine-inst"]);
    });
});
