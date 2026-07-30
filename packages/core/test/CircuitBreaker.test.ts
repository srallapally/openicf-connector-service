import { describe, it, expect, vi, afterEach } from "vitest";
import { CircuitBreaker } from "../src/infra/CircuitBreaker.js";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };

function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** Short real timeouts keep the timeout paths deterministic without fake-timer interleaving. */
const fastOpts = {
    failureThreshold: 10,   // high enough that timeouts do not open the breaker mid-test
    successThreshold: 1,
    halfOpenAfterMs: 1_000,
    maxConcurrent: 2,
    timeoutMs: 25,
};

afterEach(() => {
    vi.useRealTimers();
});

describe("CircuitBreaker in-flight accounting", () => {
    it("keeps the slot held after a timeout while the work is still running", async () => {
        const breaker = new CircuitBreaker({ ...fastOpts });
        const a = deferred<string>();
        const b = deferred<string>();

        const first = breaker.exec(() => a.promise);
        const second = breaker.exec(() => b.promise);

        await expect(first).rejects.toThrow("BreakerTimeout");
        await expect(second).rejects.toThrow("BreakerTimeout");

        // Both underlying operations are still outstanding. maxConcurrent is 2,
        // so a third caller must be refused: the slots are not free just
        // because the race gave up on them.
        await expect(breaker.exec(async () => "third")).rejects.toThrow("TooManyRequests");

        a.resolve("late-a");
        b.resolve("late-b");
    });

    it("releases the slot when the underlying work finally settles", async () => {
        const breaker = new CircuitBreaker({ ...fastOpts });
        const a = deferred<string>();
        const b = deferred<string>();

        await expect(breaker.exec(() => a.promise)).rejects.toThrow("BreakerTimeout");
        await expect(breaker.exec(() => b.promise)).rejects.toThrow("BreakerTimeout");
        await expect(breaker.exec(async () => "blocked")).rejects.toThrow("TooManyRequests");

        a.resolve("done-a");
        b.reject(new Error("failed-b"));
        // Let the release handlers run.
        await new Promise((r) => setImmediate(r));

        await expect(breaker.exec(async () => "admitted")).resolves.toBe("admitted");
    });

    it("releases the slot when fn throws synchronously", async () => {
        const breaker = new CircuitBreaker({ ...fastOpts });

        // No promise ever exists on this path, so a fix that only attaches a
        // release handler to fn()'s promise would leak the slot here.
        for (let i = 0; i < 5; i += 1) {
            await expect(breaker.exec((() => { throw new Error("sync boom"); }) as never))
                .rejects.toThrow("sync boom");
        }

        await expect(breaker.exec(async () => "ok")).resolves.toBe("ok");
    });

    it("does not produce an unhandled rejection when work rejects after its timeout", async () => {
        const seen: unknown[] = [];
        const onUnhandled = (reason: unknown) => seen.push(reason);
        process.on("unhandledRejection", onUnhandled);

        try {
            const breaker = new CircuitBreaker({ ...fastOpts });
            const d = deferred<string>();

            await expect(breaker.exec(() => d.promise)).rejects.toThrow("BreakerTimeout");

            // Reject well after the race has settled.
            d.reject(new Error("late failure"));
            await new Promise((r) => setTimeout(r, 50));

            expect(seen).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    it("counts a timeout as a failure and opens the breaker", async () => {
        const breaker = new CircuitBreaker({ ...fastOpts, failureThreshold: 2, maxConcurrent: 10 });
        const a = deferred<string>();
        const b = deferred<string>();

        await expect(breaker.exec(() => a.promise)).rejects.toThrow("BreakerTimeout");
        await expect(breaker.exec(() => b.promise)).rejects.toThrow("BreakerTimeout");

        await expect(breaker.exec(async () => "ok")).rejects.toThrow("CircuitOpen");

        a.resolve("x");
        b.resolve("y");
    });
});
