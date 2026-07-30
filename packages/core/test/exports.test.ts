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
 * threw ERR_MODULE_NOT_FOUND. Covering all six means a subpath cannot silently
 * stop resolving again.
 */
const SUBPATHS: Array<[specifier: string, expectedExport: string]> = [
    ["@openicf/connector-core", "ConnectorRegistry"],
    ["@openicf/connector-core/registry", "ConnectorRegistry"],
    ["@openicf/connector-core/infra", "CircuitBreaker"],
    ["@openicf/connector-core/spi", "GuardedString"],
    ["@openicf/connector-core/filter", "parseFilter"],
    ["@openicf/connector-core/loader", "loadExternalConnectors"],
];

describe("package export map", () => {
    for (const [specifier, expectedExport] of SUBPATHS) {
        it(`resolves ${specifier} and exposes ${expectedExport}`, async () => {
            const mod = await import(specifier);
            expect(mod[expectedExport]).toBeDefined();
        });
    }

    it("filter subpath provides the whole filter surface", async () => {
        const mod = await import("@openicf/connector-core/filter");
        for (const name of ["parseFilter", "toSql", "and", "or", "not", "cmp"]) {
            expect(typeof mod[name]).toBe("function");
        }
    });
});
