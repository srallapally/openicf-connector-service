import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../src/core/CircuitBreaker.js";

const defaultOpts = {
  failureThreshold: 2,
  successThreshold: 1,
  halfOpenAfterMs: 1_000,
  maxConcurrent: 2,
  timeoutMs: 5_000,
};

describe("CircuitBreaker", () => {
  it("opens after repeated failures and recovers after the half-open window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    try {
      const breaker = new CircuitBreaker(defaultOpts);

      const failing = vi.fn(async () => {
        throw new Error("fail");
      });

      await expect(breaker.exec(failing)).rejects.toThrow("fail");
      await expect(breaker.exec(failing)).rejects.toThrow("fail");

      await expect(breaker.exec(async () => "ok")).rejects.toThrow("CircuitOpen");

      vi.setSystemTime(1_500);

      const success = vi.fn(async () => "ok");
      await expect(breaker.exec(success)).resolves.toBe("ok");

      await expect(breaker.exec(async () => "ok" )).resolves.toBe("ok");

      expect(success).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("limits the number of inflight executions", async () => {
    const breaker = new CircuitBreaker({ ...defaultOpts, maxConcurrent: 1 });

    let release: () => void;
    const slow = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));

    const firstCall = breaker.exec(slow);

    await expect(breaker.exec(async () => "second" )).rejects.toThrow("TooManyRequests");

    release!();
    await expect(firstCall).resolves.toBeUndefined();

    expect(slow).toHaveBeenCalledTimes(1);
  });
});
