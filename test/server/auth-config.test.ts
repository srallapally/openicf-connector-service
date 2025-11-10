import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateJwtConfig, JwtConfig } from "../../src/server/auth.js";

describe("JWT Config Validation", () => {
  // Store original env vars
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Set up valid defaults for each test
    process.env.JWT_JWKS_URI = "https://example.com/.well-known/jwks.json";
    process.env.JWT_EXPECTED_ISS = "https://example.com";
    process.env.JWT_EXPECTED_AUD = "test-audience";
  });

  afterEach(() => {
    // Restore original env vars
    process.env = { ...originalEnv };
  });

  describe("Required Variables", () => {
    it("should validate successfully with all required variables set", () => {
      const config = validateJwtConfig();

      expect(config).toMatchObject({
        jwksUri: "https://example.com/.well-known/jwks.json",
        expectedIssuer: "https://example.com",
        expectedAudience: "test-audience",
      });
    });

    it("should fail when JWT_JWKS_URI is missing", () => {
      delete process.env.JWT_JWKS_URI;

      expect(() => validateJwtConfig()).toThrow(/JWT_JWKS_URI is required but not set/);
    });

    it("should fail when JWT_JWKS_URI is empty string", () => {
      process.env.JWT_JWKS_URI = "";

      expect(() => validateJwtConfig()).toThrow(/JWT_JWKS_URI is required but not set/);
    });

    it("should fail when JWT_JWKS_URI is only whitespace", () => {
      process.env.JWT_JWKS_URI = "   ";

      expect(() => validateJwtConfig()).toThrow(/JWT_JWKS_URI is required but not set/);
    });

    it("should fail when JWT_EXPECTED_ISS is missing", () => {
      delete process.env.JWT_EXPECTED_ISS;

      expect(() => validateJwtConfig()).toThrow(/JWT_EXPECTED_ISS \(issuer\) is required but not set/);
    });

    it("should fail when JWT_EXPECTED_AUD is missing", () => {
      delete process.env.JWT_EXPECTED_AUD;

      expect(() => validateJwtConfig()).toThrow(/JWT_EXPECTED_AUD \(audience\) is required but not set/);
    });

    it("should fail with multiple missing required variables and show all errors", () => {
      delete process.env.JWT_JWKS_URI;
      delete process.env.JWT_EXPECTED_ISS;
      delete process.env.JWT_EXPECTED_AUD;

      try {
        validateJwtConfig();
        expect.fail("Should have thrown validation error");
      } catch (error: any) {
        expect(error.message).toContain("JWT_JWKS_URI is required but not set");
        expect(error.message).toContain("JWT_EXPECTED_ISS (issuer) is required but not set");
        expect(error.message).toContain("JWT_EXPECTED_AUD (audience) is required but not set");
      }
    });
  });

  describe("URL Validation", () => {
    it("should accept valid HTTPS URL", () => {
      process.env.JWT_JWKS_URI = "https://auth.example.com/jwks";

      const config = validateJwtConfig();

      expect(config.jwksUri).toBe("https://auth.example.com/jwks");
    });

    it("should accept valid HTTP URL", () => {
      process.env.JWT_JWKS_URI = "http://localhost:8080/.well-known/jwks.json";

      const config = validateJwtConfig();

      expect(config.jwksUri).toBe("http://localhost:8080/.well-known/jwks.json");
    });

    it("should fail on invalid URL format", () => {
      process.env.JWT_JWKS_URI = "not-a-url";

      expect(() => validateJwtConfig()).toThrow(/JWT_JWKS_URI is not a valid URL/);
    });

    it("should fail on non-HTTP(S) protocol", () => {
      process.env.JWT_JWKS_URI = "ftp://example.com/jwks";

      expect(() => validateJwtConfig()).toThrow(/JWT_JWKS_URI must be a valid HTTP\(S\) URL/);
    });

    it("should fail on file protocol", () => {
      process.env.JWT_JWKS_URI = "file:///etc/passwd";

      expect(() => validateJwtConfig()).toThrow(/JWT_JWKS_URI must be a valid HTTP\(S\) URL/);
    });

    it("should trim whitespace from URL", () => {
      process.env.JWT_JWKS_URI = "  https://example.com/jwks  ";

      const config = validateJwtConfig();

      expect(config.jwksUri).toBe("https://example.com/jwks");
    });
  });

  describe("String Length Validation", () => {
    it("should fail when JWT_EXPECTED_ISS is too long", () => {
      process.env.JWT_EXPECTED_ISS = "a".repeat(513);

      expect(() => validateJwtConfig()).toThrow(/JWT_EXPECTED_ISS is too long \(max 512 chars\)/);
    });

    it("should accept JWT_EXPECTED_ISS at max length", () => {
      process.env.JWT_EXPECTED_ISS = "a".repeat(512);

      const config = validateJwtConfig();

      expect(config.expectedIssuer.length).toBe(512);
    });

    it("should fail when JWT_EXPECTED_AUD is too long", () => {
      process.env.JWT_EXPECTED_AUD = "a".repeat(513);

      expect(() => validateJwtConfig()).toThrow(/JWT_EXPECTED_AUD is too long \(max 512 chars\)/);
    });

    it("should fail when JWT_REQUIRED_SCOPE is too long", () => {
      process.env.JWT_REQUIRED_SCOPE = "a".repeat(257);

      expect(() => validateJwtConfig()).toThrow(/JWT_REQUIRED_SCOPE is too long \(max 256 chars\)/);
    });
  });

  describe("Algorithm Validation", () => {
    it("should use default algorithms when JWT_ALLOWED_ALGS not set", () => {
      delete process.env.JWT_ALLOWED_ALGS;

      const config = validateJwtConfig();

      expect(config.allowedAlgorithms).toEqual(["RS256", "PS256", "ES256"]);
    });

    it("should accept custom valid algorithms", () => {
      process.env.JWT_ALLOWED_ALGS = "RS256,ES384";

      const config = validateJwtConfig();

      expect(config.allowedAlgorithms).toEqual(["RS256", "ES384"]);
    });

    it("should accept all supported RSA algorithms", () => {
      process.env.JWT_ALLOWED_ALGS = "RS256,RS384,RS512";

      const config = validateJwtConfig();

      expect(config.allowedAlgorithms).toEqual(["RS256", "RS384", "RS512"]);
    });

    it("should accept all supported RSA-PSS algorithms", () => {
      process.env.JWT_ALLOWED_ALGS = "PS256,PS384,PS512";

      const config = validateJwtConfig();

      expect(config.allowedAlgorithms).toEqual(["PS256", "PS384", "PS512"]);
    });

    it("should accept all supported ECDSA algorithms", () => {
      process.env.JWT_ALLOWED_ALGS = "ES256,ES384,ES512";

      const config = validateJwtConfig();

      expect(config.allowedAlgorithms).toEqual(["ES256", "ES384", "ES512"]);
    });

    it("should accept EdDSA algorithm", () => {
      process.env.JWT_ALLOWED_ALGS = "EdDSA";

      const config = validateJwtConfig();

      expect(config.allowedAlgorithms).toEqual(["EdDSA"]);
    });

    it("should trim whitespace from algorithm names", () => {
      process.env.JWT_ALLOWED_ALGS = " RS256 , ES256 , PS256 ";

      const config = validateJwtConfig();

      expect(config.allowedAlgorithms).toEqual(["RS256", "ES256", "PS256"]);
    });

    it("should fail on unsupported algorithm", () => {
      process.env.JWT_ALLOWED_ALGS = "HS256";

      expect(() => validateJwtConfig()).toThrow(/JWT_ALLOWED_ALGS contains unsupported algorithms: HS256/);
    });

    it("should fail on multiple unsupported algorithms", () => {
      process.env.JWT_ALLOWED_ALGS = "HS256,HS384,RS256";

      try {
        validateJwtConfig();
        expect.fail("Should have thrown validation error");
      } catch (error: any) {
        expect(error.message).toContain("unsupported algorithms: HS256, HS384");
      }
    });

    it("should fail on invalid algorithm name", () => {
      process.env.JWT_ALLOWED_ALGS = "INVALID";

      expect(() => validateJwtConfig()).toThrow(/unsupported algorithms: INVALID/);
    });

    it("should fail when algorithm list is empty", () => {
      process.env.JWT_ALLOWED_ALGS = "";

      expect(() => validateJwtConfig()).toThrow(/JWT_ALLOWED_ALGS must contain at least one algorithm/);
    });

    it("should fail when algorithm list contains only whitespace", () => {
      process.env.JWT_ALLOWED_ALGS = "   ";

      expect(() => validateJwtConfig()).toThrow(/JWT_ALLOWED_ALGS must contain at least one algorithm/);
    });

    it("should filter empty strings from algorithm list", () => {
      process.env.JWT_ALLOWED_ALGS = "RS256,,ES256";

      const config = validateJwtConfig();

      expect(config.allowedAlgorithms).toEqual(["RS256", "ES256"]);
    });
  });

  describe("Clock Skew Validation", () => {
    it("should use default clock skew when not set", () => {
      delete process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC;

      const config = validateJwtConfig();

      expect(config.clockSkewSeconds).toBe(60);
    });

    it("should accept valid clock skew value", () => {
      process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC = "30";

      const config = validateJwtConfig();

      expect(config.clockSkewSeconds).toBe(30);
    });

    it("should accept zero clock skew", () => {
      process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC = "0";

      const config = validateJwtConfig();

      expect(config.clockSkewSeconds).toBe(0);
    });

    it("should accept maximum allowed clock skew (300 seconds)", () => {
      process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC = "300";

      const config = validateJwtConfig();

      expect(config.clockSkewSeconds).toBe(300);
    });

    it("should fail on non-numeric clock skew", () => {
      process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC = "not-a-number";

      expect(() => validateJwtConfig()).toThrow(/JWT_ACCEPTED_CLOCK_SKEW_SEC must be a number/);
    });

    it("should fail on negative clock skew", () => {
      process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC = "-10";

      expect(() => validateJwtConfig()).toThrow(/JWT_ACCEPTED_CLOCK_SKEW_SEC must be non-negative/);
    });

    it("should fail on clock skew exceeding maximum (300 seconds)", () => {
      process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC = "301";

      expect(() => validateJwtConfig()).toThrow(
        /JWT_ACCEPTED_CLOCK_SKEW_SEC is too large \(max 300 seconds\).*Large clock skew values weaken security/
      );
    });

    it("should fail on excessively large clock skew", () => {
      process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC = "3600";

      expect(() => validateJwtConfig()).toThrow(/too large.*weaken security/);
    });

    it("should trim whitespace from clock skew", () => {
      process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC = "  120  ";

      const config = validateJwtConfig();

      expect(config.clockSkewSeconds).toBe(120);
    });

    it("should handle decimal clock skew values", () => {
      process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC = "90.5";

      const config = validateJwtConfig();

      expect(config.clockSkewSeconds).toBe(90.5);
    });
  });

  describe("Optional Scope Validation", () => {
    it("should handle missing JWT_REQUIRED_SCOPE", () => {
      delete process.env.JWT_REQUIRED_SCOPE;

      const config = validateJwtConfig();

      expect(config.requiredScope).toBeUndefined();
    });

    it("should handle empty JWT_REQUIRED_SCOPE", () => {
      process.env.JWT_REQUIRED_SCOPE = "";

      const config = validateJwtConfig();

      expect(config.requiredScope).toBeUndefined();
    });

    it("should accept valid JWT_REQUIRED_SCOPE", () => {
      process.env.JWT_REQUIRED_SCOPE = "read:users";

      const config = validateJwtConfig();

      expect(config.requiredScope).toBe("read:users");
    });

    it("should trim whitespace from JWT_REQUIRED_SCOPE", () => {
      process.env.JWT_REQUIRED_SCOPE = "  read:users  ";

      const config = validateJwtConfig();

      expect(config.requiredScope).toBe("read:users");
    });
  });

  describe("Complex Error Scenarios", () => {
    it("should report all validation errors at once", () => {
      delete process.env.JWT_JWKS_URI;
      delete process.env.JWT_EXPECTED_ISS;
      process.env.JWT_ALLOWED_ALGS = "HS256,INVALID";
      process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC = "not-a-number";

      try {
        validateJwtConfig();
        expect.fail("Should have thrown validation error");
      } catch (error: any) {
        const message = error.message;

        // Should contain all errors
        expect(message).toContain("JWT_JWKS_URI is required but not set");
        expect(message).toContain("JWT_EXPECTED_ISS (issuer) is required but not set");
        expect(message).toContain("unsupported algorithms: HS256, INVALID");
        expect(message).toContain("JWT_ACCEPTED_CLOCK_SKEW_SEC must be a number");
      }
    });

    it("should format error message with bullet points", () => {
      delete process.env.JWT_JWKS_URI;
      delete process.env.JWT_EXPECTED_ISS;

      try {
        validateJwtConfig();
        expect.fail("Should have thrown validation error");
      } catch (error: any) {
        expect(error.message).toContain("JWT configuration validation failed:");
        expect(error.message).toContain("  - JWT_JWKS_URI");
        expect(error.message).toContain("  - JWT_EXPECTED_ISS");
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle special characters in issuer", () => {
      process.env.JWT_EXPECTED_ISS = "https://example.com/issuer?query=value&other=123";

      const config = validateJwtConfig();

      expect(config.expectedIssuer).toBe("https://example.com/issuer?query=value&other=123");
    });

    it("should handle special characters in audience", () => {
      process.env.JWT_EXPECTED_AUD = "urn:service:api:v1";

      const config = validateJwtConfig();

      expect(config.expectedAudience).toBe("urn:service:api:v1");
    });

    it("should handle URLs with authentication", () => {
      process.env.JWT_JWKS_URI = "https://user:pass@example.com/jwks";

      const config = validateJwtConfig();

      expect(config.jwksUri).toBe("https://user:pass@example.com/jwks");
    });

    it("should handle URLs with ports", () => {
      process.env.JWT_JWKS_URI = "https://example.com:8443/.well-known/jwks.json";

      const config = validateJwtConfig();

      expect(config.jwksUri).toBe("https://example.com:8443/.well-known/jwks.json");
    });

    it("should handle IPv6 URLs", () => {
      process.env.JWT_JWKS_URI = "http://[::1]:8080/jwks";

      const config = validateJwtConfig();

      expect(config.jwksUri).toBe("http://[::1]:8080/jwks");
    });
  });

  describe("Type Safety", () => {
    it("should return properly typed JwtConfig object", () => {
      const config: JwtConfig = validateJwtConfig();

      // TypeScript should enforce these types at compile time
      const uri: string = config.jwksUri;
      const issuer: string = config.expectedIssuer;
      const audience: string = config.expectedAudience;
      const algorithms: string[] = config.allowedAlgorithms;
      const skew: number = config.clockSkewSeconds;
      const scope: string | undefined = config.requiredScope;

      expect(typeof uri).toBe("string");
      expect(typeof issuer).toBe("string");
      expect(typeof audience).toBe("string");
      expect(Array.isArray(algorithms)).toBe(true);
      expect(typeof skew).toBe("number");
      expect(scope === undefined || typeof scope === "string").toBe(true);
    });
  });
});
