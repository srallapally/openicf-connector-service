import { describe, it, expect } from "vitest";
import {
    resolveRuntimeConfig,
    isMutationOp,
    OP_KINDS,
    RUNTIME_DEFAULTS,
    ATTEMPT_DEADLINE_MAX_MS,
} from "../src/config/runtime.js";
import { resolveCapabilities } from "../src/loader/types.js";

describe("resolveRuntimeConfig — defaults", () => {
    it("fills every default when the block is absent", () => {
        const r = resolveRuntimeConfig();
        expect(r.mutationConcurrency).toBe(10);
        expect(r.readConcurrency).toBe(10);
        expect(r.interactiveSliceFraction).toBe(0.2);
        expect(r.readCache).toBeNull();
        expect(r.rateLimits).toEqual({});
        for (const op of OP_KINDS) {
            expect(r.attemptDeadlineMs[op], op).toBe(RUNTIME_DEFAULTS.attemptDeadlineMs);
        }
    });

    it("treats an empty block the same as an absent one", () => {
        expect(resolveRuntimeConfig({})).toEqual(resolveRuntimeConfig());
    });

    it("does not mutate its input", () => {
        const input = { mutationConcurrency: 4 };
        const snapshot = JSON.parse(JSON.stringify(input));
        resolveRuntimeConfig(input);
        expect(input).toEqual(snapshot);
    });
});

describe("resolveRuntimeConfig — attempt deadline", () => {
    it("applies a scalar to every op", () => {
        const r = resolveRuntimeConfig({ attemptDeadlineMs: 5_000 });
        for (const op of OP_KINDS) expect(r.attemptDeadlineMs[op], op).toBe(5_000);
    });

    it("applies per-op values and defaults the rest", () => {
        const r = resolveRuntimeConfig({ attemptDeadlineMs: { create: 30_000, search: 60_000 } });
        expect(r.attemptDeadlineMs.create).toBe(30_000);
        expect(r.attemptDeadlineMs.search).toBe(60_000);
        expect(r.attemptDeadlineMs.update).toBe(RUNTIME_DEFAULTS.attemptDeadlineMs);
        expect(r.attemptDeadlineMs.delete).toBe(RUNTIME_DEFAULTS.attemptDeadlineMs);
    });

    it("rejects -1 and names the ceiling", () => {
        // -1 is the IDM idiom for "no timeout"; operators arrive expecting it
        // to work, so the message has to explain the refusal.
        expect(() => resolveRuntimeConfig({ attemptDeadlineMs: -1 }))
            .toThrow(/Unlimited \(-1\) is rejected deliberately/);
        expect(() => resolveRuntimeConfig({ attemptDeadlineMs: -1 }))
            .toThrow(new RegExp(String(ATTEMPT_DEADLINE_MAX_MS)));
    });

    it("rejects 0", () => {
        expect(() => resolveRuntimeConfig({ attemptDeadlineMs: 0 })).toThrow(/must be between 1 and 120000/);
    });

    it("rejects -1 on a single op, not just the scalar form", () => {
        expect(() => resolveRuntimeConfig({ attemptDeadlineMs: { delete: -1 } }))
            .toThrow(/runtime\.attemptDeadlineMs\.delete/);
    });

    it("enforces the ceiling and accepts the boundary", () => {
        expect(resolveRuntimeConfig({ attemptDeadlineMs: ATTEMPT_DEADLINE_MAX_MS })
            .attemptDeadlineMs.create).toBe(ATTEMPT_DEADLINE_MAX_MS);
        expect(() => resolveRuntimeConfig({ attemptDeadlineMs: ATTEMPT_DEADLINE_MAX_MS + 1 }))
            .toThrow(/above the 120000 ms ceiling/);
    });

    it("accepts the floor of 1 ms", () => {
        expect(resolveRuntimeConfig({ attemptDeadlineMs: 1 }).attemptDeadlineMs.get).toBe(1);
    });

    it("rejects non-integers", () => {
        expect(() => resolveRuntimeConfig({ attemptDeadlineMs: 1_500.5 })).toThrow(/whole number/);
        expect(() => resolveRuntimeConfig({ attemptDeadlineMs: NaN })).toThrow(/whole number/);
        expect(() => resolveRuntimeConfig({ attemptDeadlineMs: { create: 1_500.5 } })).toThrow(/whole number/);
    });

    it("rejects a value that is neither a scalar nor a per-op object", () => {
        // The scalar/object dispatch happens before the per-value parse, so a
        // string is reported against the shape rather than the range.
        expect(() => resolveRuntimeConfig({ attemptDeadlineMs: "3000" as never }))
            .toThrow(/must be a number or a per-op object/);
    });

    it("rejects an unknown op name", () => {
        expect(() => resolveRuntimeConfig({ attemptDeadlineMs: { crate: 1000 } as never }))
            .toThrow(/crate is not a known operation/);
    });
});

describe("resolveRuntimeConfig — concurrency budgets", () => {
    it("keeps the two budgets independent", () => {
        const r = resolveRuntimeConfig({ mutationConcurrency: 4, readConcurrency: 25 });
        expect(r.mutationConcurrency).toBe(4);
        expect(r.readConcurrency).toBe(25);
    });

    it("rejects zero and negative budgets", () => {
        expect(() => resolveRuntimeConfig({ mutationConcurrency: 0 })).toThrow(/at least 1/);
        expect(() => resolveRuntimeConfig({ readConcurrency: -3 })).toThrow(/at least 1/);
    });

    it("rejects fractional budgets", () => {
        expect(() => resolveRuntimeConfig({ mutationConcurrency: 2.5 })).toThrow(/whole number/);
    });
});

describe("resolveRuntimeConfig — interactive slice floor rule", () => {
    // CP-2: fraction of the mutation budget, ceil(), at least one slot once the
    // budget is 2 or more, none at a budget of 1.
    const cases: Array<[budget: number, slots: number]> = [
        [1, 0],
        [2, 1],
        [3, 1],
        [10, 2],
    ];

    for (const [budget, slots] of cases) {
        it(`reserves ${slots} slot(s) at a budget of ${budget}`, () => {
            const r = resolveRuntimeConfig({ mutationConcurrency: budget });
            expect(r.interactiveSlots).toBe(slots);
            expect(r.batchSlots).toBe(budget - slots);
        });
    }

    it("ceils rather than floors, so a small fraction still reserves a whole slot", () => {
        // 0.2 * 3 = 0.6; flooring would leave interactive work unreserved on
        // exactly the small instances where contention bites hardest.
        expect(resolveRuntimeConfig({ mutationConcurrency: 3 }).interactiveSlots).toBe(1);
        expect(resolveRuntimeConfig({ mutationConcurrency: 6, interactiveSliceFraction: 0.5 }).interactiveSlots).toBe(3);
    });

    it("treats fraction 0 as an explicit opt-out (RFE-1)", () => {
        // The floor exists to stop a small positive fraction rounding down to
        // nothing, not to override an operator who asked for none. Accepting a
        // documented, in-range value and then ignoring it was the surprise.
        expect(resolveRuntimeConfig({ mutationConcurrency: 8, interactiveSliceFraction: 0 }).interactiveSlots).toBe(0);
        expect(resolveRuntimeConfig({ mutationConcurrency: 8, interactiveSliceFraction: 0 }).batchSlots).toBe(8);
        expect(resolveRuntimeConfig({ mutationConcurrency: 1, interactiveSliceFraction: 0 }).interactiveSlots).toBe(0);
    });

    it("still floors every positive fraction at one slot", () => {
        // 0.01 of a budget of 2 is 0.02; without the floor that rounds to
        // nothing on exactly the instances where contention bites hardest.
        expect(resolveRuntimeConfig({ mutationConcurrency: 2, interactiveSliceFraction: 0.01 }).interactiveSlots).toBe(1);
        expect(resolveRuntimeConfig({ mutationConcurrency: 20, interactiveSliceFraction: 0.001 }).interactiveSlots).toBe(1);
    });

    it("never reserves more than the whole budget", () => {
        const r = resolveRuntimeConfig({ mutationConcurrency: 5, interactiveSliceFraction: 1 });
        expect(r.interactiveSlots).toBe(5);
        expect(r.batchSlots).toBe(0);
    });

    it("rejects a fraction outside [0,1]", () => {
        expect(() => resolveRuntimeConfig({ interactiveSliceFraction: -0.1 })).toThrow(/between 0 and 1/);
        expect(() => resolveRuntimeConfig({ interactiveSliceFraction: 1.5 })).toThrow(/between 0 and 1/);
    });
});

describe("resolveRuntimeConfig — rate limits", () => {
    it("is off by default", () => {
        expect(resolveRuntimeConfig({}).rateLimits).toEqual({});
    });

    it("resolves a per-op limit and leaves the timeout optional", () => {
        const r = resolveRuntimeConfig({
            rateLimits: {
                create: { requestLimit: 100, requestPeriodMs: 60_000, requestTimeoutMs: 5_000 },
                get: { requestLimit: 500, requestPeriodMs: 1_000 },
            },
        });
        expect(r.rateLimits.create).toEqual({ requestLimit: 100, requestPeriodMs: 60_000, requestTimeoutMs: 5_000 });
        expect(r.rateLimits.get).toEqual({ requestLimit: 500, requestPeriodMs: 1_000, requestTimeoutMs: undefined });
        expect(r.rateLimits.update).toBeUndefined();
    });

    it("rejects a malformed limit", () => {
        expect(() => resolveRuntimeConfig({ rateLimits: { create: { requestLimit: 0, requestPeriodMs: 1000 } } }))
            .toThrow(/requestLimit must be at least 1/);
        expect(() => resolveRuntimeConfig({ rateLimits: { create: { requestLimit: 5 } as never } }))
            .toThrow(/requestPeriodMs must be a number/);
    });

    it("rejects an unrecognised field inside a limit", () => {
        expect(() => resolveRuntimeConfig({ rateLimits: { create: { requestLimit: 5, requestPeriodMs: 1, burst: 2 } as never } }))
            .toThrow(/burst is not a recognised setting/);
    });
});

describe("resolveRuntimeConfig — read cache", () => {
    it("is absent unless configured", () => {
        expect(resolveRuntimeConfig({}).readCache).toBeNull();
    });

    it("resolves when configured", () => {
        expect(resolveRuntimeConfig({ readCache: { ttlMs: 30_000, max: 500 } }).readCache)
            .toEqual({ ttlMs: 30_000, max: 500 });
    });

    it("rejects a malformed cache block", () => {
        expect(() => resolveRuntimeConfig({ readCache: { ttlMs: 0, max: 10 } })).toThrow(/ttlMs must be at least 1/);
    });
});

describe("resolveRuntimeConfig — typo protection", () => {
    it("rejects an unknown top-level key rather than ignoring it", () => {
        // A silently ignored typo in a concurrency budget is indistinguishable
        // from the default until production load makes it obvious.
        expect(() => resolveRuntimeConfig({ mutationConcurency: 50 } as never))
            .toThrow(/mutationConcurency is not a recognised setting/);
    });

    it("rejects a non-object runtime block", () => {
        expect(() => resolveRuntimeConfig(42 as never)).toThrow(/runtime must be an object/);
    });
});

describe("op-kind helpers", () => {
    it("classifies mutations and reads", () => {
        expect(isMutationOp("create")).toBe(true);
        expect(isMutationOp("update")).toBe(true);
        expect(isMutationOp("delete")).toBe(true);
        expect(isMutationOp("get")).toBe(false);
        expect(isMutationOp("search")).toBe(false);
        expect(isMutationOp("sync")).toBe(false);
    });
});

describe("resolveCapabilities", () => {
    it("defaults every flag to false", () => {
        expect(resolveCapabilities({})).toEqual({
            poolable: false,
            idempotentDelta: false,
            equalitySearchOnName: false,
        });
    });

    it("reads declared flags", () => {
        expect(resolveCapabilities({ poolable: true, equalitySearchOnName: true })).toEqual({
            poolable: true,
            idempotentDelta: false,
            equalitySearchOnName: true,
        });
    });

    it("treats any non-true value as false", () => {
        // The flags gate retry and read-back behaviour, so only an explicit
        // true may enable them.
        expect(resolveCapabilities({ idempotentDelta: "yes" as never }).idempotentDelta).toBe(false);
    });
});
