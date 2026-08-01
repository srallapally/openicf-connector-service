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
        expect(r.readCache).toBeNull();
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
    it("rejects the scheduling settings that moved to the provisioning service", () => {
        // interactiveSliceFraction and rateLimits are claim-loop concerns and
        // left at CP-5. An instance config still carrying them should say so
        // rather than silently ignore them.
        expect(() => resolveRuntimeConfig({ interactiveSliceFraction: 0.2 } as never))
            .toThrow(/interactiveSliceFraction is not a recognised setting/);
        expect(() => resolveRuntimeConfig({ rateLimits: {} } as never))
            .toThrow(/rateLimits is not a recognised setting/);
    });

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
