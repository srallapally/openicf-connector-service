// test/harness/clock.ts
//
// Fake-clock helpers for TTL eviction, retry backoff, read-back delay, and
// token-bucket refill. Every timing test drives this rather than sleeping, so
// the suite stays fast and does not flake under load.

import { vi } from "vitest";

/** Default origin for fake time. Fixed so failures are reproducible. */
export const CLOCK_ORIGIN = Date.UTC(2026, 7, 1, 0, 0, 0);

export interface FakeClock {
  /** Current fake epoch milliseconds. Pass as the `now` seam to code under test. */
  now(): number;
  /** Advance time and let every timer and promise chain it releases settle. */
  advance(ms: number): Promise<void>;
  /** Advance without draining promises, for asserting a timer has not yet run. */
  advanceSync(ms: number): void;
  restore(): void;
}

/**
 * Install fake timers anchored at a fixed origin.
 *
 * `shouldAdvanceTime` is deliberately off: time moves only when a test says
 * so, which is what makes "the TTL had not elapsed yet" assertable rather
 * than racy.
 */
export function useFakeClock(origin: number = CLOCK_ORIGIN): FakeClock {
  vi.useFakeTimers({ now: origin, shouldAdvanceTime: false });

  return {
    now: () => Date.now(),
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
    },
    advanceSync(ms: number) {
      vi.advanceTimersByTime(ms);
    },
    restore() {
      vi.useRealTimers();
    },
  };
}
