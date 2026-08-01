import { describe, it, expect } from "vitest";

/**
 * Every subpath declared in packages/core/package.json "exports", with a
 * symbol each is expected to provide.
 *
 * This resolves through the package's own export map rather than by relative
 * path, so it exercises what a consumer actually gets. That means it reads
 * from dist and therefore requires a prior `npm run build` -- CI runs build
 * before test, so the ordering already holds.
 *
 * ./filter was declared in the export map but had no index, so importing it
 * threw ERR_MODULE_NOT_FOUND. Covering every one means a subpath cannot silently
 * stop resolving again.
 */
const SUBPATHS: Array<[specifier: string, expectedExport: string]> = [
    ["@governance-connector-framework/core", "ConnectorRegistry"],
    ["@governance-connector-framework/core/registry", "ConnectorRegistry"],
    ["@governance-connector-framework/core/infra", "CircuitBreaker"],
    ["@governance-connector-framework/core/spi", "GuardedString"],
    ["@governance-connector-framework/core/spi", "ConnectorError"],
    ["@governance-connector-framework/core", "ConnectorError"],
    ["@governance-connector-framework/core", "isConnectorError"],
    ["@governance-connector-framework/core/testing", "makeFakeConnector"],
    ["@governance-connector-framework/core/testing", "deferred"],
    // Its own subpath since BUG-6: the barrel used to re-export it, which
    // pulled vitest into the graph of anyone wanting only makeFakeConnector.
    ["@governance-connector-framework/core/testing/clock", "useFakeClock"],
    ["@governance-connector-framework/core/filter", "parseFilter"],
    ["@governance-connector-framework/core/loader", "loadExternalConnectors"],
];

describe("package export map", () => {
    for (const [specifier, expectedExport] of SUBPATHS) {
        it(`resolves ${specifier} and exposes ${expectedExport}`, async () => {
            const mod = await import(specifier);
            expect(mod[expectedExport]).toBeDefined();
        });
    }

    it("does not put vitest in the graph of the testing barrel", async () => {
        // makeFakeConnector has to be usable from a plain node process -- the
        // soak script is one. Importing vitest outside a worker throws, so a
        // clean import here is the assertion (BUG-6).
        const mod = await import("@governance-connector-framework/core/testing");
        expect(mod.useFakeClock).toBeUndefined();
        expect(typeof mod.makeFakeConnector).toBe("function");
    });

    it("filter subpath provides the whole filter surface", async () => {
        const mod = await import("@governance-connector-framework/core/filter");
        for (const name of ["parseFilter", "toSql", "and", "or", "not", "cmp"]) {
            expect(typeof mod[name]).toBe("function");
        }
    });
});
