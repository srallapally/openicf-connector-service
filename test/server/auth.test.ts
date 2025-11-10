import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Set required environment variables before importing auth module
process.env.JWT_JWKS_URI = "https://example.com/.well-known/jwks.json";
process.env.JWT_EXPECTED_ISS = "https://example.com";
process.env.JWT_EXPECTED_AUD = "test-audience";

import { JtiCache } from "../../src/server/auth.js";

describe("JtiCache - Memory Exhaustion Fix", () => {
  let cache: JtiCache;

  beforeEach(() => {
    cache = new JtiCache();
  });

  afterEach(() => {
    cache.clear();
  });

  describe("Basic Functionality", () => {
    it("should store and retrieve JTI entries", () => {
      const jti = "test-jti-123";
      const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      cache.put(jti, futureExp);

      expect(cache.has(jti)).toBe(true);
      expect(cache.size()).toBe(1);
    });

    it("should detect replay attacks (duplicate JTI)", () => {
      const jti = "test-jti-456";
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put(jti, futureExp);

      // First check should succeed
      expect(cache.has(jti)).toBe(true);

      // Second check should also detect it (replay attack)
      expect(cache.has(jti)).toBe(true);
    });

    it("should return false for non-existent JTI", () => {
      expect(cache.has("non-existent-jti")).toBe(false);
    });

    it("should clear all entries", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put("jti-1", futureExp);
      cache.put("jti-2", futureExp);
      cache.put("jti-3", futureExp);

      expect(cache.size()).toBe(3);

      cache.clear();

      expect(cache.size()).toBe(0);
      expect(cache.has("jti-1")).toBe(false);
    });
  });

  describe("Memory Exhaustion Protection", () => {
    it("should enforce maximum size limit", () => {
      const smallCache = new JtiCache(100); // Small size for testing
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // Add 150 entries (exceeds limit)
      for (let i = 0; i < 150; i++) {
        smallCache.put(`jti-${i}`, futureExp);
      }

      // Cache should not exceed max size
      expect(smallCache.size()).toBeLessThanOrEqual(100);
    });

    it("should evict oldest entries when max size is reached", () => {
      const smallCache = new JtiCache(10);
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // Add 10 entries
      for (let i = 0; i < 10; i++) {
        smallCache.put(`jti-${i}`, futureExp);
      }

      // First entry should exist
      expect(smallCache.has("jti-0")).toBe(true);

      // Add 5 more entries (exceeds limit)
      for (let i = 10; i < 15; i++) {
        smallCache.put(`jti-${i}`, futureExp);
      }

      // Oldest entries should be evicted
      expect(smallCache.size()).toBeLessThanOrEqual(10);

      // Latest entries should still exist
      expect(smallCache.has("jti-14")).toBe(true);
    });

    it("should handle rapid sequential insertions without memory leak", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // Simulate attack: rapid insertion of unique JTIs
      for (let i = 0; i < 50000; i++) {
        cache.put(`attack-jti-${i}`, futureExp);
      }

      // Should be capped at max size (10,000)
      expect(cache.size()).toBeLessThanOrEqual(10000);
    });
  });

  describe("TTL and Expiry Handling", () => {
    it("should not store already-expired tokens", () => {
      const jti = "expired-jti";
      const pastExp = Math.floor(Date.now() / 1000) - 100; // 100 seconds ago

      cache.put(jti, pastExp);

      // Should not be stored
      expect(cache.has(jti)).toBe(false);
      expect(cache.size()).toBe(0);
    });

    it("should not store tokens expiring at current time", () => {
      const jti = "current-time-jti";
      const currentExp = Math.floor(Date.now() / 1000); // Now

      cache.put(jti, currentExp);

      // Should not be stored (ttl would be 0 or negative)
      expect(cache.has(jti)).toBe(false);
    });

    it("should automatically expire entries based on token expiry", async () => {
      const jti = "short-lived-jti";
      const shortExp = Math.floor(Date.now() / 1000) + 1; // 1 second from now

      cache.put(jti, shortExp);

      // Should exist immediately
      expect(cache.has(jti)).toBe(true);

      // Wait for expiry (1.1 seconds to account for timing)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be automatically removed
      expect(cache.has(jti)).toBe(false);
    }, 10000); // 10s test timeout

    it("should handle long-lived tokens correctly", () => {
      const jti = "long-lived-jti";
      const longExp = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now

      cache.put(jti, longExp);

      expect(cache.has(jti)).toBe(true);
      expect(cache.size()).toBe(1);
    });

    it("should calculate TTL correctly for various expiry times", () => {
      const now = Math.floor(Date.now() / 1000);

      // 5 minutes from now
      cache.put("jti-5min", now + 300);
      expect(cache.has("jti-5min")).toBe(true);

      // 1 hour from now
      cache.put("jti-1hour", now + 3600);
      expect(cache.has("jti-1hour")).toBe(true);

      // 24 hours from now
      cache.put("jti-24hour", now + 86400);
      expect(cache.has("jti-24hour")).toBe(true);

      expect(cache.size()).toBe(3);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty JTI strings", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put("", futureExp);

      expect(cache.has("")).toBe(true);
      expect(cache.size()).toBe(1);
    });

    it("should handle very long JTI strings", () => {
      const longJti = "a".repeat(10000); // 10KB JTI
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put(longJti, futureExp);

      expect(cache.has(longJti)).toBe(true);
    });

    it("should handle special characters in JTI", () => {
      const specialJti = "jti-!@#$%^&*()_+-=[]{}|;:',.<>?/~`";
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put(specialJti, futureExp);

      expect(cache.has(specialJti)).toBe(true);
    });

    it("should handle Unicode characters in JTI", () => {
      const unicodeJti = "jti-测试-🔐-مرحبا";
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put(unicodeJti, futureExp);

      expect(cache.has(unicodeJti)).toBe(true);
    });

    it("should handle negative expiry times", () => {
      const jti = "negative-exp-jti";
      const negativeExp = -1000;

      cache.put(jti, negativeExp);

      // Should not be stored
      expect(cache.has(jti)).toBe(false);
    });

    it("should handle very large expiry times", () => {
      const jti = "far-future-jti";
      const farFutureExp = Math.floor(Date.now() / 1000) + 365 * 86400; // 1 year

      cache.put(jti, farFutureExp);

      expect(cache.has(jti)).toBe(true);
    });
  });

  describe("Concurrent Access Simulation", () => {
    it("should handle concurrent reads and writes", async () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const promises: Promise<void>[] = [];

      // Simulate concurrent writes
      for (let i = 0; i < 100; i++) {
        promises.push(
          Promise.resolve().then(() => {
            cache.put(`concurrent-jti-${i}`, futureExp);
          })
        );
      }

      // Simulate concurrent reads
      for (let i = 0; i < 100; i++) {
        promises.push(
          Promise.resolve().then(() => {
            cache.has(`concurrent-jti-${i}`);
          })
        );
      }

      await Promise.all(promises);

      // Should have stored all entries
      expect(cache.size()).toBeGreaterThan(0);
      expect(cache.size()).toBeLessThanOrEqual(100);
    });
  });

  describe("Custom Max Size", () => {
    it("should respect custom max size in constructor", () => {
      const customCache = new JtiCache(50);
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      for (let i = 0; i < 100; i++) {
        customCache.put(`jti-${i}`, futureExp);
      }

      expect(customCache.size()).toBeLessThanOrEqual(50);
    });

    it("should use default max size of 10,000 when not specified", () => {
      const defaultCache = new JtiCache();
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // Add more than 10,000 entries
      for (let i = 0; i < 15000; i++) {
        defaultCache.put(`jti-${i}`, futureExp);
      }

      expect(defaultCache.size()).toBeLessThanOrEqual(10000);
    });
  });

  describe("Security Scenarios", () => {
    it("should prevent replay attack within valid token lifetime", () => {
      const jti = "replay-attack-jti";
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // First authentication with this JTI
      cache.put(jti, futureExp);

      // Attacker tries to reuse the same token (replay attack)
      const isReplayAttempt = cache.has(jti);

      expect(isReplayAttempt).toBe(true); // Detected!
    });

    it("should allow different JTIs even with same expiry", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put("jti-user1", futureExp);
      cache.put("jti-user2", futureExp);
      cache.put("jti-user3", futureExp);

      expect(cache.has("jti-user1")).toBe(true);
      expect(cache.has("jti-user2")).toBe(true);
      expect(cache.has("jti-user3")).toBe(true);
      expect(cache.size()).toBe(3);
    });

    it("should resist memory exhaustion DoS attack", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // Attacker generates many tokens with unique JTIs
      for (let i = 0; i < 100000; i++) {
        cache.put(`dos-attack-${i}`, futureExp);
      }

      // Cache should be bounded at 10,000 entries (CRITICAL security property)
      expect(cache.size()).toBe(10000);

      // Verify oldest entries were evicted (LRU behavior)
      expect(cache.has("dos-attack-0")).toBe(false);
      expect(cache.has("dos-attack-1000")).toBe(false);

      // Verify newest entries are retained
      expect(cache.has("dos-attack-99999")).toBe(true);
      expect(cache.has("dos-attack-99998")).toBe(true);
    });
  });
});
