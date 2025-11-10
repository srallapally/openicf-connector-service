import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RateLimiter } from "../src/infra/RateLimiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Initialization", () => {
    it("should start with full bucket", () => {
      const limiter = new RateLimiter(10, 5);
      expect(limiter.getAvailableTokens()).toBe(10);
    });

    it("should use default values when not specified", () => {
      const limiter = new RateLimiter();
      expect(limiter.getAvailableTokens()).toBe(20); // Default maxTokens
    });

    it("should initialize violation count to zero", () => {
      const limiter = new RateLimiter();
      expect(limiter.getViolationCount()).toBe(0);
    });
  });

  describe("Token Consumption", () => {
    it("should consume tokens on successful request", () => {
      const limiter = new RateLimiter(10, 5);
      expect(limiter.tryConsume(1)).toBe(true);
      expect(limiter.getAvailableTokens()).toBe(9);
    });

    it("should consume fractional tokens", () => {
      const limiter = new RateLimiter(10, 5);
      expect(limiter.tryConsume(0.5)).toBe(true);
      expect(limiter.getAvailableTokens()).toBe(9); // Floor of 9.5
    });

    it("should consume multiple tokens in one request", () => {
      const limiter = new RateLimiter(10, 5);
      expect(limiter.tryConsume(3)).toBe(true);
      expect(limiter.getAvailableTokens()).toBe(7);
    });

    it("should reject when insufficient tokens", () => {
      const limiter = new RateLimiter(5, 5);

      // Consume all tokens
      for (let i = 0; i < 5; i++) {
        expect(limiter.tryConsume(1)).toBe(true);
      }

      // Next request should be rejected
      expect(limiter.tryConsume(1)).toBe(false);
      expect(limiter.getAvailableTokens()).toBe(0);
    });

    it("should increment violation count on rejection", () => {
      const limiter = new RateLimiter(1, 5);

      limiter.tryConsume(1); // Use the only token
      expect(limiter.tryConsume(1)).toBe(false);
      expect(limiter.getViolationCount()).toBe(1);

      expect(limiter.tryConsume(1)).toBe(false);
      expect(limiter.getViolationCount()).toBe(2);
    });
  });

  describe("Token Refill", () => {
    it("should refill tokens over time", () => {
      const limiter = new RateLimiter(10, 5); // 5 tokens per second

      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume(1);
      }
      expect(limiter.getAvailableTokens()).toBe(0);

      // Advance time by 1 second
      vi.advanceTimersByTime(1000);

      // Should have 5 tokens (5 per second refill rate)
      expect(limiter.getAvailableTokens()).toBe(5);
    });

    it("should refill proportionally for partial seconds", () => {
      const limiter = new RateLimiter(10, 10); // 10 tokens per second

      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume(1);
      }

      // Advance time by 500ms (0.5 seconds)
      vi.advanceTimersByTime(500);

      // Should have 5 tokens (10/sec * 0.5sec)
      expect(limiter.getAvailableTokens()).toBe(5);
    });

    it("should cap tokens at maximum capacity", () => {
      const limiter = new RateLimiter(10, 5);

      // Start with full bucket (10 tokens)
      expect(limiter.getAvailableTokens()).toBe(10);

      // Wait 10 seconds (would add 50 tokens if uncapped)
      vi.advanceTimersByTime(10000);

      // Should still be capped at 10
      expect(limiter.getAvailableTokens()).toBe(10);
    });

    it("should allow burst after refill period", () => {
      const limiter = new RateLimiter(10, 5);

      // Consume 8 tokens
      for (let i = 0; i < 8; i++) {
        limiter.tryConsume(1);
      }
      expect(limiter.getAvailableTokens()).toBe(2);

      // Wait 2 seconds (adds 10 tokens, capped at 10 total)
      vi.advanceTimersByTime(2000);

      // Should have full bucket again
      expect(limiter.getAvailableTokens()).toBe(10);

      // Should allow burst of 10 requests
      for (let i = 0; i < 10; i++) {
        expect(limiter.tryConsume(1)).toBe(true);
      }
    });
  });

  describe("Rate Limiting Behavior", () => {
    it("should enforce 300 requests per minute (default config)", () => {
      const limiter = new RateLimiter(20, 5); // Match HTTP: 5 req/sec = 300 req/min

      // Should allow burst of 20
      for (let i = 0; i < 20; i++) {
        expect(limiter.tryConsume(1)).toBe(true);
      }

      // Next request should fail
      expect(limiter.tryConsume(1)).toBe(false);

      // Wait 1 second, should get 5 more tokens
      vi.advanceTimersByTime(1000);
      for (let i = 0; i < 5; i++) {
        expect(limiter.tryConsume(1)).toBe(true);
      }

      // Should fail again
      expect(limiter.tryConsume(1)).toBe(false);
    });

    it("should allow sustained rate of 5 requests per second", () => {
      const limiter = new RateLimiter(20, 5);

      // Consume initial burst
      for (let i = 0; i < 20; i++) {
        limiter.tryConsume(1);
      }

      // Over 10 seconds, should allow ~50 requests (5 per second)
      let successCount = 0;
      for (let sec = 0; sec < 10; sec++) {
        vi.advanceTimersByTime(1000);

        // Try to consume up to 5 tokens
        for (let i = 0; i < 5; i++) {
          if (limiter.tryConsume(1)) {
            successCount++;
          }
        }
      }

      expect(successCount).toBe(50);
    });

    it("should handle mixed lightweight and heavy operations", () => {
      const limiter = new RateLimiter(10, 5);

      // Consume with different costs (simulating ping=0.5, operation=1)
      expect(limiter.tryConsume(0.5)).toBe(true); // ping
      expect(limiter.tryConsume(0.5)).toBe(true); // ping
      expect(limiter.tryConsume(1)).toBe(true);   // operation
      expect(limiter.tryConsume(1)).toBe(true);   // operation

      // Used 3 tokens total (0.5 + 0.5 + 1 + 1)
      expect(limiter.getAvailableTokens()).toBe(7);
    });
  });

  describe("Reset Functionality", () => {
    it("should reset to full bucket", () => {
      const limiter = new RateLimiter(10, 5);

      // Consume tokens
      for (let i = 0; i < 8; i++) {
        limiter.tryConsume(1);
      }
      expect(limiter.getAvailableTokens()).toBe(2);

      // Reset
      limiter.reset();
      expect(limiter.getAvailableTokens()).toBe(10);
    });

    it("should reset violation count", () => {
      const limiter = new RateLimiter(1, 5);

      limiter.tryConsume(1);
      limiter.tryConsume(1); // violation
      limiter.tryConsume(1); // violation
      expect(limiter.getViolationCount()).toBe(2);

      limiter.reset();
      expect(limiter.getViolationCount()).toBe(0);
    });

    it("should reset refill timer", () => {
      const limiter = new RateLimiter(10, 5);

      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume(1);
      }

      // Advance time
      vi.advanceTimersByTime(2000);

      // Reset (should restart refill timer)
      limiter.reset();
      expect(limiter.getAvailableTokens()).toBe(10);

      // Advance time again
      vi.advanceTimersByTime(1000);

      // Should still be capped at 10 (not 10 + refill from before reset)
      expect(limiter.getAvailableTokens()).toBe(10);
    });
  });

  describe("Edge Cases", () => {
    it("should handle zero cost consumption", () => {
      const limiter = new RateLimiter(10, 5);
      expect(limiter.tryConsume(0)).toBe(true);
      expect(limiter.getAvailableTokens()).toBe(10);
    });

    it("should handle very small time increments", () => {
      const limiter = new RateLimiter(10, 5);
      limiter.tryConsume(10);

      // Advance by 1ms
      vi.advanceTimersByTime(1);

      // Should refill by 0.005 tokens (5 tokens/sec * 0.001 sec)
      const tokens = limiter.getAvailableTokens();
      expect(tokens).toBe(0); // Floor of 0.005
    });

    it("should handle rapid consecutive calls", () => {
      const limiter = new RateLimiter(5, 5);

      // Rapid fire requests
      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(limiter.tryConsume(1));
      }

      // First 5 should succeed, rest fail
      expect(results.slice(0, 5).every(r => r === true)).toBe(true);
      expect(results.slice(5).every(r => r === false)).toBe(true);
    });

    it("should handle large token costs", () => {
      const limiter = new RateLimiter(10, 5);

      // Consume more than available
      expect(limiter.tryConsume(15)).toBe(false);
      expect(limiter.getViolationCount()).toBe(1);

      // Original tokens should be preserved
      expect(limiter.getAvailableTokens()).toBe(10);
    });

    it("should handle very long wait times", () => {
      const limiter = new RateLimiter(10, 5);
      limiter.tryConsume(10);

      // Wait 1 hour
      vi.advanceTimersByTime(3600000);

      // Should be capped at max (not accumulated)
      expect(limiter.getAvailableTokens()).toBe(10);
    });
  });

  describe("Security Properties", () => {
    it("should prevent token accumulation beyond max", () => {
      const limiter = new RateLimiter(10, 5);

      // Wait a very long time
      vi.advanceTimersByTime(100000);

      // Tokens should not exceed max
      expect(limiter.getAvailableTokens()).toBeLessThanOrEqual(10);
    });

    it("should track violations for monitoring", () => {
      const limiter = new RateLimiter(2, 5);

      limiter.tryConsume(1);
      limiter.tryConsume(1);

      // These should be violations
      limiter.tryConsume(1);
      limiter.tryConsume(1);
      limiter.tryConsume(1);

      expect(limiter.getViolationCount()).toBe(3);
    });

    it("should handle negative time (clock skew)", () => {
      const limiter = new RateLimiter(10, 5);
      const initialTokens = limiter.getAvailableTokens();

      // This shouldn't cause issues even with clock adjustments
      expect(limiter.tryConsume(1)).toBe(true);
      expect(limiter.getAvailableTokens()).toBe(initialTokens - 1);
    });
  });

  describe("Real-World Scenarios", () => {
    it("should handle WebSocket message spam scenario", () => {
      // Simulate authenticated attacker spamming operations
      const limiter = new RateLimiter(20, 5); // Default config

      let blocked = 0;
      let allowed = 0;

      // Spam 100 messages as fast as possible
      for (let i = 0; i < 100; i++) {
        if (limiter.tryConsume(1)) {
          allowed++;
        } else {
          blocked++;
        }
      }

      // Should block most requests after initial burst
      expect(allowed).toBe(20); // Only burst capacity
      expect(blocked).toBe(80); // Rest blocked
      expect(limiter.getViolationCount()).toBe(80);
    });

    it("should allow legitimate bursty traffic", () => {
      const limiter = new RateLimiter(20, 5);

      // Legitimate user sends burst of 15 requests
      for (let i = 0; i < 15; i++) {
        expect(limiter.tryConsume(1)).toBe(true);
      }

      // Waits 1 second
      vi.advanceTimersByTime(1000);

      // Sends another burst of 5
      for (let i = 0; i < 5; i++) {
        expect(limiter.tryConsume(1)).toBe(true);
      }

      expect(limiter.getViolationCount()).toBe(0);
    });

    it("should handle mixed ping and operation traffic", () => {
      const limiter = new RateLimiter(20, 5);

      // Simulate realistic WebSocket traffic pattern
      const operations = [
        { type: "ping", cost: 0.5 },
        { type: "ping", cost: 0.5 },
        { type: "operation", cost: 1 },
        { type: "list-connectors", cost: 0.5 },
        { type: "operation", cost: 1 },
        { type: "ping", cost: 0.5 },
      ];

      let allowed = 0;
      for (const op of operations) {
        if (limiter.tryConsume(op.cost)) {
          allowed++;
        }
      }

      expect(allowed).toBe(6); // All should be allowed
      expect(limiter.getViolationCount()).toBe(0);

      // Total cost: 0.5 + 0.5 + 1 + 0.5 + 1 + 0.5 = 4 tokens
      expect(limiter.getAvailableTokens()).toBe(16);
    });
  });

  describe("Performance Characteristics", () => {
    it("should handle high request rates efficiently", () => {
      const limiter = new RateLimiter(100, 50);

      const startTime = Date.now();

      // Process 1000 requests
      for (let i = 0; i < 1000; i++) {
        limiter.tryConsume(1);
      }

      const elapsed = Date.now() - startTime;

      // Should complete quickly (< 100ms for 1000 operations)
      expect(elapsed).toBeLessThan(100);
    });

    it("should have minimal memory footprint", () => {
      // Rate limiter should only store a few numbers
      const limiter = new RateLimiter(10, 5);

      // Object should be small
      const keys = Object.keys(limiter);
      expect(keys.length).toBeLessThanOrEqual(6); // Only a few fields
    });
  });
});
