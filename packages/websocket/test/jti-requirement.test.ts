import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Type-only import: erased at compile time, so it does not execute auth.ts.
import type { TokenReplayCache as TokenReplayCacheType } from "../src/security/auth.js";

// Set required environment variables before importing auth module.
process.env.JWT_JWKS_URI = "https://example.com/.well-known/jwks.json";
process.env.JWT_EXPECTED_ISS = "https://example.com";
process.env.JWT_EXPECTED_AUD = "test-audience";

// Must be a dynamic import: static ESM imports are hoisted above the
// assignments above, so auth.ts would run validateJwtConfig() with no env set.
const { TokenReplayCache, JtiCache } = await import("../src/security/auth.js");

// Set up environment cleanup for tests
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.JWT_JWKS_URI = "https://example.com/.well-known/jwks.json";
  process.env.JWT_EXPECTED_ISS = "https://example.com";
  process.env.JWT_EXPECTED_AUD = "test-audience";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("JTI Requirement - Replay Protection Fix", () => {
  let cache: TokenReplayCacheType;

  beforeEach(() => {
    cache = new TokenReplayCache();
  });

  afterEach(() => {
    cache.clear();
  });

  describe("TokenReplayCache - Backwards Compatibility", () => {
    it("should export JtiCache as alias to TokenReplayCache", () => {
      expect(JtiCache).toBe(TokenReplayCache);
    });

    it("should maintain original JtiCache API", () => {
      const legacyCache = new JtiCache();
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      legacyCache.put("jti-123", futureExp);
      expect(legacyCache.has("jti-123")).toBe(true);
      expect(legacyCache.size()).toBe(1);

      legacyCache.clear();
      expect(legacyCache.size()).toBe(0);
    });
  });

  describe("TokenReplayCache - Enhanced Functionality", () => {
    it("should store and retrieve token identifiers", () => {
      const identifier = "test-token-id";
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put(identifier, futureExp);

      expect(cache.has(identifier)).toBe(true);
      expect(cache.size()).toBe(1);
    });

    it("should handle JTI-based identifiers", () => {
      const jti = "550e8400-e29b-41d4-a716-446655440000"; // UUID format
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put(jti, futureExp);

      expect(cache.has(jti)).toBe(true);
    });

    it("should handle fallback identifiers (sub+iat+hash)", () => {
      const fallbackId = "fallback:user123:1699564800:abc123";
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put(fallbackId, futureExp);

      expect(cache.has(fallbackId)).toBe(true);
    });

    it("should distinguish between different token identifiers", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put("jti-1", futureExp);
      cache.put("jti-2", futureExp);
      cache.put("fallback:user1:123:abc", futureExp);

      expect(cache.has("jti-1")).toBe(true);
      expect(cache.has("jti-2")).toBe(true);
      expect(cache.has("fallback:user1:123:abc")).toBe(true);
      expect(cache.has("jti-3")).toBe(false);
      expect(cache.size()).toBe(3);
    });
  });

  describe("Replay Attack Detection", () => {
    it("should detect replay of JTI-based token", () => {
      const jti = "attack-jti-123";
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // First use - should be stored
      cache.put(jti, futureExp);
      expect(cache.has(jti)).toBe(true);

      // Second use - replay detected
      const isReplay = cache.has(jti);
      expect(isReplay).toBe(true); // This indicates a replay attack
    });

    it("should detect replay of fallback identifier", () => {
      const fallbackId = "fallback:user456:1699564800:xyz789";
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // First use
      cache.put(fallbackId, futureExp);
      expect(cache.has(fallbackId)).toBe(true);

      // Second use - replay detected
      expect(cache.has(fallbackId)).toBe(true);
    });

    it("should prevent multiple uses of same token", () => {
      const jti = "one-time-token";
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put(jti, futureExp);

      // Simulate multiple replay attempts
      for (let i = 0; i < 10; i++) {
        expect(cache.has(jti)).toBe(true); // All attempts detected
      }
    });
  });

  describe("Identifier Format Validation", () => {
    it("should accept various JTI formats (UUID, alphanumeric, etc)", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      const jtiFormats = [
        "550e8400-e29b-41d4-a716-446655440000", // UUID
        "abc123def456", // Alphanumeric
        "jti_" + "a".repeat(32), // Prefix + random
        "base64encodedvalue==", // Base64-like
        "123456789", // Numeric
      ];

      jtiFormats.forEach(jti => {
        cache.put(jti, futureExp);
        expect(cache.has(jti)).toBe(true);
      });
    });

    it("should accept fallback identifier format", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      const fallbackFormats = [
        "fallback:user123:1699564800:abc",
        "fallback:admin:1699564900:xyz",
        "fallback:service-account:1699565000:123",
      ];

      fallbackFormats.forEach(id => {
        cache.put(id, futureExp);
        expect(cache.has(id)).toBe(true);
      });
    });

    it("should handle empty string identifier", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put("", futureExp);
      expect(cache.has("")).toBe(true);
    });

    it("should handle very long identifiers", () => {
      const longId = "jti-" + "x".repeat(1000);
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put(longId, futureExp);
      expect(cache.has(longId)).toBe(true);
    });
  });

  describe("TTL and Expiry Management", () => {
    it("should not store expired tokens", () => {
      const jti = "expired-token";
      const pastExp = Math.floor(Date.now() / 1000) - 100;

      cache.put(jti, pastExp);

      expect(cache.has(jti)).toBe(false);
      expect(cache.size()).toBe(0);
    });

    it("should automatically expire tokens after TTL", async () => {
      const jti = "short-lived-token";
      const shortExp = Math.floor(Date.now() / 1000) + 1; // 1 second

      cache.put(jti, shortExp);
      expect(cache.has(jti)).toBe(true);

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 1100));

      expect(cache.has(jti)).toBe(false);
    }, 10000);

    it("should handle tokens with different expiry times", () => {
      const now = Math.floor(Date.now() / 1000);

      cache.put("short-lived", now + 60); // 1 minute
      cache.put("medium-lived", now + 3600); // 1 hour
      cache.put("long-lived", now + 86400); // 24 hours

      expect(cache.has("short-lived")).toBe(true);
      expect(cache.has("medium-lived")).toBe(true);
      expect(cache.has("long-lived")).toBe(true);
      expect(cache.size()).toBe(3);
    });
  });

  describe("Memory Protection", () => {
    it("should enforce maximum size limit (10,000 entries)", () => {
      const smallCache = new TokenReplayCache(100);
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // Add 150 entries
      for (let i = 0; i < 150; i++) {
        smallCache.put(`token-${i}`, futureExp);
      }

      expect(smallCache.size()).toBeLessThanOrEqual(100);
    });

    it("should handle mixed JTI and fallback identifiers in cache", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // Mix of JTI and fallback identifiers
      for (let i = 0; i < 50; i++) {
        cache.put(`jti-${i}`, futureExp);
        cache.put(`fallback:user${i}:${Date.now()}:hash${i}`, futureExp);
      }

      expect(cache.size()).toBe(100);
    });

    it("should prevent DoS via rapid identifier insertion", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // Simulate attack with 20,000 unique identifiers
      for (let i = 0; i < 20000; i++) {
        cache.put(`attack-${i}`, futureExp);
      }

      // Should be capped at 10,000
      expect(cache.size()).toBeLessThanOrEqual(10000);
    });
  });

  describe("Security Properties", () => {
    it("should maintain separation between JTI and fallback namespaces", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // Even if fallback ID matches a JTI, they should be distinct
      cache.put("abc123", futureExp); // JTI
      cache.put("fallback:user:123:abc123", futureExp); // Fallback

      expect(cache.has("abc123")).toBe(true);
      expect(cache.has("fallback:user:123:abc123")).toBe(true);
      expect(cache.size()).toBe(2);
    });

    it("should resist collision attacks on fallback identifiers", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      // Try to create collisions with similar but different identifiers
      cache.put("fallback:alice:1000:hash1", futureExp);
      cache.put("fallback:alice:1001:hash1", futureExp); // Different iat
      cache.put("fallback:alice:1000:hash2", futureExp); // Different hash

      // All should be distinct
      expect(cache.size()).toBe(3);
    });

    it("should handle Unicode characters in identifiers", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      const unicodeIds = [
        "jti-测试-123",
        "fallback:user-مرحبا:1000:abc",
        "token-🔐-secure",
      ];

      unicodeIds.forEach(id => {
        cache.put(id, futureExp);
        expect(cache.has(id)).toBe(true);
      });
    });

    it("should handle special characters in identifiers safely", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      const specialIds = [
        "jti:with:colons",
        "fallback|with|pipes",
        "token#with#hashes",
        "id'with'quotes",
      ];

      specialIds.forEach(id => {
        cache.put(id, futureExp);
        expect(cache.has(id)).toBe(true);
      });
    });
  });

  describe("Cache Operations", () => {
    it("should clear all entries", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put("jti-1", futureExp);
      cache.put("jti-2", futureExp);
      cache.put("fallback:user:123:abc", futureExp);

      expect(cache.size()).toBe(3);

      cache.clear();

      expect(cache.size()).toBe(0);
      expect(cache.has("jti-1")).toBe(false);
      expect(cache.has("jti-2")).toBe(false);
    });

    it("should report accurate size", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      expect(cache.size()).toBe(0);

      cache.put("token-1", futureExp);
      expect(cache.size()).toBe(1);

      cache.put("token-2", futureExp);
      expect(cache.size()).toBe(2);

      cache.clear();
      expect(cache.size()).toBe(0);
    });
  });

  describe("Concurrent Access Simulation", () => {
    it("should handle concurrent token identifier storage", async () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const promises: Promise<void>[] = [];

      // Simulate concurrent writes
      for (let i = 0; i < 100; i++) {
        promises.push(
          Promise.resolve().then(() => {
            cache.put(`concurrent-token-${i}`, futureExp);
          })
        );
      }

      await Promise.all(promises);

      expect(cache.size()).toBeGreaterThan(0);
      expect(cache.size()).toBeLessThanOrEqual(100);
    });

    it("should handle concurrent replay checks", async () => {
      const jti = "shared-token";
      const futureExp = Math.floor(Date.now() / 1000) + 3600;

      cache.put(jti, futureExp);

      const promises: Promise<boolean>[] = [];

      // Simulate concurrent replay checks
      for (let i = 0; i < 50; i++) {
        promises.push(
          Promise.resolve().then(() => cache.has(jti))
        );
      }

      const results = await Promise.all(promises);

      // All should detect the token
      expect(results.every(r => r === true)).toBe(true);
    });
  });
});
