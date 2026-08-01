import { describe, it, expect, vi, afterEach } from "vitest";
import { ConnectorFacade, DeadlineExpiredError, isDeadlineExpired } from "../src/registry/ConnectorFacade.js";
import { resolveRuntimeConfig } from "../src/config/runtime.js";
import { makeFakeConnector } from "./harness/FakeConnector.js";
import { deferred } from "./harness/async.js";
import type { OperationOptions } from "../src/spi/types.js";

afterEach(() => { vi.useRealTimers(); });

const OC = "__ACCOUNT__";

const withDeadline = (ms: number) =>
    ({ runtime: resolveRuntimeConfig({ attemptDeadlineMs: ms }) });

describe("attempt deadline", () => {
    it("aborts a hung connector at the configured budget", async () => {
        vi.useFakeTimers();
        const c = makeFakeConnector();
        c.controls.hangUntilAborted();

        const facade = new ConnectorFacade(c, "a", withDeadline(3_000));
        const call = facade.create(OC, { __NAME__: "hung" });
        const settled = call.then(() => "resolved", e => e);

        await vi.advanceTimersByTimeAsync(2_999);
        expect(c.controls.calls.at(-1)!.abortHonored).toBe(false);

        await vi.advanceTimersByTimeAsync(2);
        const err = await settled;

        expect(isDeadlineExpired(err)).toBe(true);
        expect((err as DeadlineExpiredError).op).toBe("create");
        // The connector was told to stop, not merely abandoned.
        expect(c.controls.calls.at(-1)!.abortHonored).toBe(true);
    });

    it("reports DeadlineExpired even though the connector rejected with AbortError", async () => {
        // The connector's AbortError is a symptom of our own timer firing.
        // Surfacing it would lose the distinction between "the target refused"
        // and "we stopped waiting", which is what separates FAILED_CONFIRMED
        // from INDETERMINATE.
        vi.useFakeTimers();
        const c = makeFakeConnector();
        c.controls.hangUntilAborted();

        const facade = new ConnectorFacade(c, "a", withDeadline(1_000));
        const settled = facade.create(OC, { __NAME__: "x" }).catch(e => e);

        await vi.advanceTimersByTimeAsync(1_001);
        const err = await settled;

        expect(err.name).toBe("DeadlineExpiredError");
        expect(err.name).not.toBe("AbortError");
    });

    it("leaves a mutation that applied before the deadline discoverable by read-back", async () => {
        vi.useFakeTimers();
        const c = makeFakeConnector();
        c.controls.applyThenHang();

        const facade = new ConnectorFacade(c, "a", withDeadline(1_000));
        const settled = facade.create(OC, { __NAME__: "ghost" }).catch(e => e);

        await vi.advanceTimersByTimeAsync(1_001);
        expect(isDeadlineExpired(await settled)).toBe(true);

        // INDETERMINATE, not failed: the account exists and read-back finds it.
        expect(c.controls.target.findByName("ghost")).toBeDefined();
    });

    it("uses the smaller of the caller's remaining budget and the attempt budget", async () => {
        vi.useFakeTimers();
        const c = makeFakeConnector();
        c.controls.hangUntilAborted();

        const facade = new ConnectorFacade(c, "a", withDeadline(60_000));
        // Caller has only 500ms left of an end-to-end budget.
        const settled = facade
            .create(OC, { __NAME__: "x" }, { deadlineEpochMs: Date.now() + 500 })
            .catch(e => e);

        await vi.advanceTimersByTimeAsync(501);
        expect(isDeadlineExpired(await settled)).toBe(true);
    });

    it("refuses to dispatch when the caller's budget is already spent", async () => {
        const c = makeFakeConnector();
        const facade = new ConnectorFacade(c, "a", withDeadline(3_000));

        const err = await facade
            .create(OC, { __NAME__: "x" }, { deadlineEpochMs: Date.now() - 1 })
            .catch(e => e);

        expect(isDeadlineExpired(err)).toBe(true);
        // Nothing was attempted: burning a slot on work nobody awaits is waste.
        expect(c.controls.countOf("create")).toBe(0);
    });

    it("passes an absolute deadline and a live signal down to the connector", async () => {
        let seen: OperationOptions | undefined;
        const impl = {
            create: vi.fn(async (_oc: string, _attrs: any, options?: OperationOptions) => {
                seen = options;
                return { uid: "1", attributes: {} };
            }),
        };
        const facade = new ConnectorFacade(impl, "a", withDeadline(5_000));

        const before = Date.now();
        await facade.create(OC, { __NAME__: "x" });

        expect(seen).toBeDefined();
        expect(seen!.abortSignal).toBeInstanceOf(AbortSignal);
        expect(seen!.abortSignal!.aborted).toBe(false);
        // Absolute, not a duration, and derived from this attempt's budget.
        expect(seen!.deadlineEpochMs).toBeGreaterThanOrEqual(before + 5_000);
        expect(seen!.deadlineEpochMs).toBeLessThanOrEqual(Date.now() + 5_000);
    });

    it("preserves the caller's other options while overriding signal and deadline", async () => {
        let seen: OperationOptions | undefined;
        const impl = {
            get: vi.fn(async (_oc: string, _uid: string, options?: OperationOptions) => {
                seen = options;
                return null;
            }),
        };
        const facade = new ConnectorFacade(impl, "a", withDeadline(2_000));

        await facade.get(OC, "u1", { attributesToGet: ["mail"], pageSize: 7, priority: "interactive" });

        expect(seen).toMatchObject({ attributesToGet: ["mail"], pageSize: 7, priority: "interactive" });
        expect(seen!.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it("does not fire the deadline for a call that completes in time", async () => {
        vi.useFakeTimers();
        const c = makeFakeConnector();
        c.controls.latency(100);

        const facade = new ConnectorFacade(c, "a", withDeadline(5_000));
        const call = facade.create(OC, { __NAME__: "quick" });

        await vi.advanceTimersByTimeAsync(101);
        await expect(call).resolves.toMatchObject({ uid: expect.any(String) });
    });
});

describe("abort propagation", () => {
    it("forwards the caller's abort to the connector", async () => {
        const c = makeFakeConnector();
        c.controls.hangUntilAborted();

        const ac = new AbortController();
        const facade = new ConnectorFacade(c, "a", withDeadline(60_000));
        const settled = facade.create(OC, { __NAME__: "x" }, { abortSignal: ac.signal }).catch(e => e);

        await Promise.resolve();
        ac.abort();

        const err = await settled;
        // A caller-initiated abort is not a deadline expiry: the caller knows
        // it cancelled, and the framework should not relabel that.
        expect(isDeadlineExpired(err)).toBe(false);
        expect(err.name).toBe("AbortError");
        expect(c.controls.calls.at(-1)!.abortHonored).toBe(true);
    });

    it("gives the connector a signal even when the caller supplied none", async () => {
        const c = makeFakeConnector();
        const facade = new ConnectorFacade(c, "a");
        await facade.create(OC, { __NAME__: "x" });

        // hangUntilAborted only works because a signal is always present.
        c.controls.hangUntilAborted();
        vi.useFakeTimers();
        const settled = facade.create(OC, { __NAME__: "y" }).catch(e => e);
        await vi.advanceTimersByTimeAsync(3_001);
        expect(isDeadlineExpired(await settled)).toBe(true);
    });
});

describe("breaker limits come from runtime config", () => {
    it("sheds load past the configured mutation concurrency", async () => {
        const runtime = resolveRuntimeConfig({ mutationConcurrency: 2, readConcurrency: 8 });
        const gate = deferred<void>();
        const impl = {
            create: vi.fn(async () => { await gate.promise; return { uid: "1", attributes: {} }; }),
        };
        const facade = new ConnectorFacade(impl, "a", { runtime });

        const inflight = [
            facade.create(OC, {}).catch(e => e),
            facade.create(OC, {}).catch(e => e),
        ];
        await Promise.resolve();

        // Third mutation exceeds the budget: instant shed is the correct
        // admission semantics, not a queue that hides the overload.
        const third = await facade.create(OC, {}).catch(e => e);
        expect(String(third.message)).toContain("TooManyRequests");

        gate.resolve();
        await Promise.all(inflight);
    });

    it("keeps the read plane independent of the mutation plane", async () => {
        // A slow streaming search must not consume the slots a mutation needs.
        const runtime = resolveRuntimeConfig({ mutationConcurrency: 1, readConcurrency: 4 });
        const gate = deferred<void>();
        const impl = {
            get: vi.fn(async () => { await gate.promise; return { uid: "1", attributes: {} }; }),
            create: vi.fn(async () => ({ uid: "2", attributes: {} })),
        };
        const facade = new ConnectorFacade(impl, "a", { runtime });

        const reads = [facade.get(OC, "1"), facade.get(OC, "2"), facade.get(OC, "3")];
        await Promise.resolve();

        await expect(facade.create(OC, {})).resolves.toBeDefined();

        gate.resolve();
        await Promise.all(reads);
    });
});
