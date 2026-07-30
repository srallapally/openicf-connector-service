import { describe, it, expect, vi } from "vitest";
import { ConnectorFacade } from "../src/registry/ConnectorFacade.js";
import type { ResultsHandler } from "../src/spi/icf-compat.js";

describe("ConnectorFacade.search capability detection", () => {
    it("passes options, not a handler, to a list-style connector declaring three params", async () => {
        // Three named params is the ordinary list-style shape. Arity sniffing
        // (search.length >= 3) misread it as streaming and put a ResultsHandler
        // where the connector expects its options.
        const impl = {
            search: vi.fn(async (_objectClass: string, _filter: any, _options?: any) => ({
                results: [{ uid: "1", attributes: {} }],
            })),
        };

        const facade = new ConnectorFacade(impl, "list-3");
        const opts = { pageSize: 25 };
        const out: any = await facade.search("account", null, opts);

        const [, , third, fourth] = impl.search.mock.calls[0]!;
        expect(typeof third).not.toBe("function");
        expect(third).toEqual(opts);
        expect(fourth).toBeUndefined();
        expect(out.results).toHaveLength(1);
    });

    it("routes a two-param list-style connector to the list branch", async () => {
        const impl = {
            search: vi.fn(async (_objectClass: string, _filter: any) => ({ results: [] })),
        };

        const facade = new ConnectorFacade(impl, "list-2");
        const opts = { pageSize: 5 };
        const out: any = await facade.search("account", null, opts);

        expect(impl.search.mock.calls[0]).toEqual(["account", null, opts]);
        expect(out.results).toEqual([]);
    });

    it("uses the streaming branch only when searchStreaming is true", async () => {
        const impl = {
            searchStreaming: true,
            search: vi.fn(async (
                _objectClass: string,
                _filter: any,
                handler: ResultsHandler,
                _options?: any,
            ) => {
                for (let i = 0; i < 5; i += 1) {
                    await handler({ uid: String(i), attributes: {} } as any);
                }
                return { pagedResultsCookie: null, remainingPagedResults: 0 };
            }),
        };

        const facade = new ConnectorFacade(impl, "stream");
        const out: any = await facade.search("account", null);

        expect(typeof impl.search.mock.calls[0]![2]).toBe("function");
        expect(out.results).toHaveLength(5);
        expect(out.searchResult).toEqual({ pagedResultsCookie: null, remainingPagedResults: 0 });
    });

    it("caps the streaming buffer at options.pageSize and stops the connector", async () => {
        const handlerReturns: boolean[] = [];
        const impl = {
            searchStreaming: true,
            search: vi.fn(async (
                _objectClass: string,
                _filter: any,
                handler: ResultsHandler,
                _options?: any,
            ) => {
                for (let i = 0; i < 100; i += 1) {
                    const cont = await handler({ uid: String(i), attributes: {} } as any);
                    handlerReturns.push(cont);
                    if (!cont) break;
                }
                return { pagedResultsCookie: "more", remainingPagedResults: -1 };
            }),
        };

        const facade = new ConnectorFacade(impl, "stream-paged");
        const out: any = await facade.search("account", null, { pageSize: 10 });

        expect(out.results).toHaveLength(10);
        expect(handlerReturns).toHaveLength(10);
        expect(handlerReturns.slice(0, 9).every(Boolean)).toBe(true);
        expect(handlerReturns[9]).toBe(false);
    });

    it("throws when the connector has no search", async () => {
        const facade = new ConnectorFacade({}, "none");
        await expect(facade.search("account", null)).rejects.toThrow("Search not supported");
    });
});
