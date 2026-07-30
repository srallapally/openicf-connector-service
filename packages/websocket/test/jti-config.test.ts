import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Set required environment variables before importing modules that validate on load
process.env.JWT_JWKS_URI = "https://example.com/.well-known/jwks.json";
process.env.JWT_EXPECTED_ISS = "https://example.com";
process.env.JWT_EXPECTED_AUD = "test-audience";

describe("JWT Configuration - JTI Requirement", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Ensure required JWT config
    process.env.JWT_JWKS_URI = "https://example.com/.well-known/jwks.json";
    process.env.JWT_EXPECTED_ISS = "https://example.com";
    process.env.JWT_EXPECTED_AUD = "test-audience";
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;

    // Clear module cache to allow re-import with new env vars
    vi.resetModules();
  });

  describe("JWT_REQUIRE_JTI Environment Variable", () => {
    it("should default to true (secure by default) when not set", async () => {
      delete process.env.JWT_REQUIRE_JTI;

      const { validateJwtConfig } = await import("../src/security/auth.js");
      const config = validateJwtConfig();

      expect(config.requireJti).toBe(true);
    });

    it("should accept 'true' value", async () => {
      process.env.JWT_REQUIRE_JTI = "true";

      const { validateJwtConfig } = await import("../src/security/auth.js");
      const config = validateJwtConfig();

      expect(config.requireJti).toBe(true);
    });

    it("should accept 'false' value with warning", async () => {
      process.env.JWT_REQUIRE_JTI = "false";

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { validateJwtConfig } = await import("../src/security/auth.js");
      const config = validateJwtConfig();

      expect(config.requireJti).toBe(false);

      // Should log security warning
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[SECURITY WARNING]")
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("JWT_REQUIRE_JTI is set to false")
      );

      consoleSpy.mockRestore();
    });

    it("should reject invalid values", async () => {
      process.env.JWT_REQUIRE_JTI = "maybe";

      // Import will throw because validation happens on module load
      await expect(async () => {
        await import("../src/security/auth.js");
      }).rejects.toThrow(/JWT_REQUIRE_JTI must be "true" or "false"/);
    });

    it("should reject numeric values", async () => {
      process.env.JWT_REQUIRE_JTI = "1";

      // Import will throw because validation happens on module load
      await expect(async () => {
        await import("../src/security/auth.js");
      }).rejects.toThrow(/JWT_REQUIRE_JTI must be "true" or "false"/);
    });

    it("should default to true for empty string", async () => {
      process.env.JWT_REQUIRE_JTI = "";

      const { validateJwtConfig } = await import("../src/security/auth.js");

      // Empty string after trim should default to true
      const config = validateJwtConfig();
      expect(config.requireJti).toBe(true);
    });

    it("should handle whitespace in values", async () => {
      process.env.JWT_REQUIRE_JTI = "  true  ";

      const { validateJwtConfig } = await import("../src/security/auth.js");
      const config = validateJwtConfig();

      expect(config.requireJti).toBe(true);
    });

    it("should be case-sensitive", async () => {
      process.env.JWT_REQUIRE_JTI = "TRUE";

      // Import will throw because validation happens on module load
      await expect(async () => {
        await import("../src/security/auth.js");
      }).rejects.toThrow(/JWT_REQUIRE_JTI must be "true" or "false"/);
    });
  });

  describe("Configuration Security Defaults", () => {
    it("should require JTI by default for new deployments", async () => {
      // Minimal config - rely on defaults
      delete process.env.JWT_REQUIRE_JTI;
      delete process.env.JWT_REQUIRED_SCOPE;
      delete process.env.JWT_ALLOWED_ALGS;

      const { validateJwtConfig } = await import("../src/security/auth.js");
      const config = validateJwtConfig();

      expect(config.requireJti).toBe(true);
    });

    it("should allow opting out for legacy systems", async () => {
      process.env.JWT_REQUIRE_JTI = "false";

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { validateJwtConfig } = await import("../src/security/auth.js");
      const config = validateJwtConfig();

      expect(config.requireJti).toBe(false);

      consoleSpy.mockRestore();
    });
  });

  describe("Configuration Validation Integration", () => {
    it("should validate all JWT config including requireJti", async () => {
      process.env.JWT_REQUIRE_JTI = "true";
      process.env.JWT_ALLOWED_ALGS = "RS256,ES256";
      process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC = "120";

      const { validateJwtConfig } = await import("../src/security/auth.js");
      const config = validateJwtConfig();

      expect(config.requireJti).toBe(true);
      expect(config.allowedAlgorithms).toContain("RS256");
      expect(config.allowedAlgorithms).toContain("ES256");
      expect(config.clockSkewSeconds).toBe(120);
    });

    it("should include requireJti in config object", async () => {
      const { validateJwtConfig } = await import("../src/security/auth.js");
      const config = validateJwtConfig();

      expect(config).toHaveProperty("requireJti");
      expect(typeof config.requireJti).toBe("boolean");
    });
  });

  describe("Security Warning Messages", () => {
    it("should warn about replay attack risk when JTI not required", async () => {
      process.env.JWT_REQUIRE_JTI = "false";

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { validateJwtConfig } = await import("../src/security/auth.js");
      validateJwtConfig();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("weaker fallback replay protection")
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("increases the risk of replay attacks")
      );

      consoleSpy.mockRestore();
    });

    it("should not warn when JTI is required (default)", async () => {
      delete process.env.JWT_REQUIRE_JTI;

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { validateJwtConfig } = await import("../src/security/auth.js");
      validateJwtConfig();

      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("Fail-Fast Validation", () => {
    it("should fail on module load with invalid config", async () => {
      process.env.JWT_REQUIRE_JTI = "invalid";

      await expect(async () => {
        await import("../src/security/auth.js");
      }).rejects.toThrow();
    });

    it("should not start server with invalid JTI requirement config", async () => {
      process.env.JWT_REQUIRE_JTI = "yes";

      // Import will throw because validation happens on module load
      await expect(async () => {
        await import("../src/security/auth.js");
      }).rejects.toThrow(/JWT configuration validation failed/);
    });
  });

  describe("Edge Cases", () => {
    it("should handle undefined vs empty string", async () => {
      // Undefined - should default to true
      delete process.env.JWT_REQUIRE_JTI;
      const { validateJwtConfig: validate1 } = await import("../src/security/auth.js");
      const config1 = validate1();
      expect(config1.requireJti).toBe(true);

      vi.resetModules();

      // Ensure required env vars are set for second test
      process.env.JWT_JWKS_URI = "https://example.com/.well-known/jwks.json";
      process.env.JWT_EXPECTED_ISS = "https://example.com";
      process.env.JWT_EXPECTED_AUD = "test-audience";

      // Empty string after trim - should default to true
      process.env.JWT_REQUIRE_JTI = "   ";
      const { validateJwtConfig: validate2 } = await import("../src/security/auth.js");
      const config2 = validate2();
      expect(config2.requireJti).toBe(true);
    });

    it("should handle mixed case with trim", async () => {
      process.env.JWT_REQUIRE_JTI = "  false  ";

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { validateJwtConfig } = await import("../src/security/auth.js");
      const config = validateJwtConfig();

      expect(config.requireJti).toBe(false);

      consoleSpy.mockRestore();
    });
  });

  describe("Documentation and Error Messages", () => {
    it("should provide clear error message for invalid values", async () => {
      process.env.JWT_REQUIRE_JTI = "1";

      // Import will throw because validation happens on module load
      await expect(async () => {
        await import("../src/security/auth.js");
      }).rejects.toThrow(/JWT_REQUIRE_JTI must be "true" or "false", got: 1/);
    });

    it("should list all validation errors together", async () => {
      process.env.JWT_REQUIRE_JTI = "invalid";
      delete process.env.JWT_JWKS_URI; // Also make this invalid

      // Import will throw because validation happens on module load
      await expect(async () => {
        await import("../src/security/auth.js");
      }).rejects.toThrow(/JWT configuration validation failed/);
    });
  });

  describe("Type Safety", () => {
    it("should have requireJti as boolean type in config", async () => {
      const { validateJwtConfig } = await import("../src/security/auth.js");
      const config = validateJwtConfig();

      // Type check
      const requireJti: boolean = config.requireJti;
      expect(typeof requireJti).toBe("boolean");
    });
  });
});
