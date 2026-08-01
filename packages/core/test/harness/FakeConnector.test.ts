import { describe, it, expect, vi, afterEach } from "vitest";
import { makeFakeConnector, FakeTarget } from "./FakeConnector.js";
import { isConnectorError } from "../../src/spi/errors.js";
import type { ResultsHandler } from "../../src/spi/icf-compat.js";

afterEach(() => { vi.useRealTimers(); });

const OC = "__ACCOUNT__";

/** The harness is only load-bearing if its own faults behave. */
describe("FakeConnector — target behaviour", () => {
    it("mints a uid on create and reads it back", async () => {
        const c = makeFakeConnector();
        const created = await c.create!(OC, { __NAME__: "jdoe" });
        expect(created.uid).toMatch(/^uid-\d+$/);

        const fetched = await c.get!(OC, created.uid);
        expect(fetched!.attributes["__NAME__"]).toBe("jdoe");
    });

    it("throws ALREADY_EXISTS when the name is taken", async () => {
        const c = makeFakeConnector();
        await c.create!(OC, { __NAME__: "jdoe" });

        const err = await c.create!(OC, { __NAME__: "jdoe" }).catch(e => e);
        expect(isConnectorError(err)).toBe(true);
        expect(err.code).toBe("ALREADY_EXISTS");
    });

    it("throws UNKNOWN_UID for update and delete of a missing object", async () => {
        const c = makeFakeConnector();
        for (const call of [c.update!(OC, "ghost", { x: 1 }), c.delete!(OC, "ghost")]) {
            const err = await call.catch((e: unknown) => e);
            expect(isConnectorError(err)).toBe(true);
            expect((err as { code: string }).code).toBe("UNKNOWN_UID");
        }
    });

    it("frees the name once the object is deleted", async () => {
        const c = makeFakeConnector();
        const first = await c.create!(OC, { __NAME__: "jdoe" });
        await c.delete!(OC, first.uid);
        // The delete-then-recreate case: the name must be reusable.
        await expect(c.create!(OC, { __NAME__: "jdoe" })).resolves.toBeDefined();
    });

    it("applies update with replace semantics", async () => {
        const c = makeFakeConnector();
        const created = await c.create!(OC, { __NAME__: "jdoe", title: "clerk" });
        await c.update!(OC, created.uid, { title: "manager" });
        const got = await c.get!(OC, created.uid);
        expect(got!.attributes["title"]).toBe("manager");
        expect(got!.attributes["__NAME__"]).toBe("jdoe");
    });

    it("shares one target across separate SPI instances", async () => {
        // Pooling hands out N distinct SPI objects that must all see one target.
        const target = new FakeTarget();
        const a = makeFakeConnector({ target });
        const b = makeFakeConnector({ target });

        const created = await a.create!(OC, { __NAME__: "shared" });
        expect(await b.get!(OC, created.uid)).not.toBeNull();
    });
});

describe("FakeConnector — fault modes", () => {
    it("latency is sticky until cleared", async () => {
        vi.useFakeTimers();
        const c = makeFakeConnector();
        c.controls.latency(500);

        const inFlight = c.create!(OC, { __NAME__: "slow" });
        let settled = false;
        void inFlight.then(() => { settled = true; });

        await vi.advanceTimersByTimeAsync(499);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await inFlight;
        expect(settled).toBe(true);

        c.controls.latency(0);
        await expect(c.create!(OC, { __NAME__: "fast" })).resolves.toBeDefined();
    });

    it("failNext fires once and only once", async () => {
        const c = makeFakeConnector();
        c.controls.failNext("PERMISSION_DENIED");

        const err = await c.create!(OC, { __NAME__: "a" }).catch(e => e);
        expect(err.code).toBe("PERMISSION_DENIED");

        // The armed fault is consumed, so the retry gets through.
        await expect(c.create!(OC, { __NAME__: "a" })).resolves.toBeDefined();
    });

    it("failNext leaves the target untouched", async () => {
        const c = makeFakeConnector();
        c.controls.failNext("CONNECTION_FAILED");
        await c.create!(OC, { __NAME__: "never" }).catch(() => {});
        expect(c.controls.target.size).toBe(0);
    });

    it("hangUntilAborted never settles until the signal fires", async () => {
        const c = makeFakeConnector();
        c.controls.hangUntilAborted();

        const ac = new AbortController();
        const call = c.create!(OC, { __NAME__: "hung" }, { abortSignal: ac.signal });

        let settled = false;
        void call.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);

        ac.abort();
        const err = await call.catch(e => e);
        expect(err.name).toBe("AbortError");
        // Nothing was applied, which is what separates this from applyThenHang.
        expect(c.controls.target.size).toBe(0);
        expect(c.controls.calls.at(-1)!.abortHonored).toBe(true);
    });

    it("applyThenHang applies the mutation and still never answers", async () => {
        // The INDETERMINATE case that makes read-back necessary.
        const c = makeFakeConnector();
        c.controls.applyThenHang();

        const ac = new AbortController();
        const call = c.create!(OC, { __NAME__: "ghost" }, { abortSignal: ac.signal });

        await Promise.resolve();
        await Promise.resolve();
        expect(c.controls.target.size).toBe(1);   // the target really did it

        ac.abort();
        await expect(call).rejects.toThrow();     // and we never found out

        // A read-back by name is what recovers the truth.
        expect(c.controls.target.findByName("ghost")).toBeDefined();
    });

    it("rejects immediately if the signal is already aborted", async () => {
        const c = makeFakeConnector();
        const ac = new AbortController();
        ac.abort();

        await expect(c.create!(OC, { __NAME__: "x" }, { abortSignal: ac.signal })).rejects.toThrow();
        expect(c.controls.target.size).toBe(0);
    });

    it("reset clears armed faults and the call log but keeps target state", async () => {
        const c = makeFakeConnector();
        await c.create!(OC, { __NAME__: "keep" });
        c.controls.failNext("UNKNOWN");

        c.controls.reset();

        expect(c.controls.calls).toHaveLength(0);
        expect(c.controls.target.size).toBe(1);
        await expect(c.create!(OC, { __NAME__: "other" })).resolves.toBeDefined();
    });
});

describe("FakeConnector — call log", () => {
    it("records every operation with its arguments", async () => {
        const c = makeFakeConnector();
        const created = await c.create!(OC, { __NAME__: "jdoe" });
        await c.get!(OC, created.uid);
        await c.delete!(OC, created.uid);

        expect(c.controls.calls.map(x => x.op)).toEqual(["create", "get", "delete"]);
        expect(c.controls.countOf("create")).toBe(1);
        expect(c.controls.calls[0]!.args[0]).toBe(OC);
    });

    it("records a call even when it fails", async () => {
        const c = makeFakeConnector();
        c.controls.failNext("UNKNOWN");
        await c.create!(OC, { __NAME__: "x" }).catch(() => {});
        expect(c.controls.countOf("create")).toBe(1);
    });
});

describe("FakeConnector — search", () => {
    it("finds an object by naming attribute for read-back", async () => {
        const c = makeFakeConnector();
        await c.create!(OC, { __NAME__: "jdoe" });

        const res: any = await c.search!(OC, { attribute: "__NAME__", value: "jdoe" });
        expect(res.results).toHaveLength(1);
        expect(res.results[0].attributes["__NAME__"]).toBe("jdoe");
    });

    it("returns nothing when the object was never created", async () => {
        const c = makeFakeConnector();
        const res: any = await c.search!(OC, { attribute: "__NAME__", value: "absent" });
        expect(res.results).toHaveLength(0);
    });

    it("refuses equality-by-name when the capability is not declared", async () => {
        // Mirrors a connector whose manifest omits equalitySearchOnName: the
        // dispatcher must record INDETERMINATE instead of attempting read-back.
        const c = makeFakeConnector({ equalitySearchOnName: false });
        await c.create!(OC, { __NAME__: "jdoe" });
        await expect(c.search!(OC, { attribute: "__NAME__", value: "jdoe" })).rejects.toThrow(/not supported/);
    });

    it("streams to the caller's handler and stops when it returns false", async () => {
        const c = makeFakeConnector({ searchStreaming: true });
        for (const n of ["a", "b", "c"]) await c.create!(OC, { __NAME__: n });

        const seen: string[] = [];
        const handler: ResultsHandler = (obj) => {
            seen.push(String(obj.attributes["__NAME__"]));
            return seen.length < 2;   // stop after two
        };

        await c.search!(OC, null, handler);
        expect(seen).toEqual(["a", "b"]);
    });

    it("declares its streaming mode explicitly", () => {
        expect(makeFakeConnector({ searchStreaming: true }).searchStreaming).toBe(true);
        expect(makeFakeConnector().searchStreaming).toBe(false);
    });
});

describe("FakeConnector — omitted operations", () => {
    it("leaves omitted operations undefined so 'not supported' paths are reachable", () => {
        const c = makeFakeConnector({ omit: ["search", "sync"] });
        expect(c.search).toBeUndefined();
        expect(c.sync).toBeUndefined();
        expect(c.create).toBeDefined();
    });
});
