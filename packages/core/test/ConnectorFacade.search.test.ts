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
        // The caller's options survive; the framework adds its own deadline
        // and signal alongside them.
        expect(third).toMatchObject(opts);
        expect(third.abortSignal).toBeInstanceOf(AbortSignal);
        expect(typeof third.deadlineEpochMs).toBe("number");
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

        const [oc, filter, third] = impl.search.mock.calls[0]!;
        expect([oc, filter]).toEqual(["account", null]);
        expect(third).toMatchObject(opts);
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

describe("ConnectorFacade.search streams end to end", () => {
    it("hands the caller's handler straight to a streaming connector", async () => {
        // The ICF contract: results reach the caller as they are produced.
        // Buffering them first defeats the streaming the connector implements
        // and puts an unbounded result set in memory.
        let handedIn: unknown;
        const impl = {
            searchStreaming: true,
            search: vi.fn(async (_oc: string, _f: any, handler: ResultsHandler) => {
                handedIn = handler;
                for (let i = 0; i < 3; i++) handler({ uid: String(i), attributes: {} } as any);
                return { pagedResultsCookie: null, remainingPagedResults: 0 };
            }),
        };

        const seen: string[] = [];
        const callerHandler: ResultsHandler = (o) => { seen.push(o.uid); return true; };

        const facade = new ConnectorFacade(impl, "stream");
        const res: any = await facade.search("account", null, callerHandler);

        expect(handedIn).toBe(callerHandler);        // the very same function
        expect(seen).toEqual(["0", "1", "2"]);
        expect(res).toEqual({ pagedResultsCookie: null, remainingPagedResults: 0 });
    });

    it("lets a handler returning false stop production at the connector", async () => {
        // Backpressure has to reach the source; this is what makes an HTTP
        // client disconnect stop the target-side scan.
        let produced = 0;
        const impl = {
            searchStreaming: true,
            search: vi.fn(async (_oc: string, _f: any, handler: ResultsHandler) => {
                for (let i = 0; i < 1000; i++) {
                    produced++;
                    if (handler({ uid: String(i), attributes: {} } as any) === false) break;
                }
                return { pagedResultsCookie: "more", remainingPagedResults: -1 };
            }),
        };

        const seen: string[] = [];
        const facade = new ConnectorFacade(impl, "stream");
        await facade.search("account", null, (o: any) => { seen.push(o.uid); return seen.length < 4; });

        expect(seen).toHaveLength(4);
        expect(produced).toBe(4);   // the connector stopped, it was not drained
    });

    it("adapts a list connector to a caller-supplied handler", async () => {
        const impl = {
            search: vi.fn(async () => ({ results: [
                { uid: "a", attributes: {} },
                { uid: "b", attributes: {} },
                { uid: "c", attributes: {} },
            ] })),
        };

        const seen: string[] = [];
        const facade = new ConnectorFacade(impl, "list");
        await facade.search("account", null, (o: any) => { seen.push(o.uid); return seen.length < 2; });

        // A list connector cannot be stopped early, but the handler's contract
        // is still honoured on this side of it.
        expect(seen).toEqual(["a", "b"]);
    });

    it("keeps the list form working for callers that want a materialized page", async () => {
        // The websocket transport serializes a page into a message, so it asks
        // for a list. Buffering there is the caller's choice, not the facade
        // quietly defeating a streaming connector.
        const impl = {
            searchStreaming: true,
            search: vi.fn(async (_oc: string, _f: any, handler: ResultsHandler) => {
                for (let i = 0; i < 100; i++) {
                    if (handler({ uid: String(i), attributes: {} } as any) === false) break;
                }
                return { pagedResultsCookie: "more", remainingPagedResults: -1 };
            }),
        };

        const facade = new ConnectorFacade(impl, "stream");
        const out: any = await facade.search("account", null, { pageSize: 10 });

        expect(out.results).toHaveLength(10);
        expect(out.searchResult).toEqual({ pagedResultsCookie: "more", remainingPagedResults: -1 });
    });
});
