/**
 * Comprehensive CSRF Protection Tests
 *
 * Tests cover:
 * - Token generation and validation (positive and negative cases)
 * - Origin/Referer header validation (positive and negative cases)
 * - WebSocket origin validation (positive and negative cases)
 * - CSRF middleware behavior (positive and negative cases)
 * - CSRF token endpoint (positive cases)
 */

import { describe, it, expect, beforeEach } from "vitest";
import express, { type Express, type Request, type Response } from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import {
  generateCsrfToken,
  verifyCsrfToken,
  validateOrigin,
  validateWebSocketOrigin,
  csrfProtection,
  csrfTokenEndpoint,
  type CsrfConfig,
} from "./csrf.js";

describe("CSRF Token Generation and Validation", () => {
  const testSecret = "test-secret-key-for-signing-tokens";

  describe("generateCsrfToken", () => {
    it("should generate a valid token with signature", () => {
      const token = generateCsrfToken(testSecret);

      // Token should be in format: token.signature
      expect(token).toMatch(/^[a-f0-9]{64}\.[a-f0-9]{64}$/);
    });

    it("should generate unique tokens on each call", () => {
      const token1 = generateCsrfToken(testSecret);
      const token2 = generateCsrfToken(testSecret);

      expect(token1).not.toBe(token2);
    });
  });

  describe("verifyCsrfToken - Positive Cases", () => {
    it("should verify a valid token", () => {
      const token = generateCsrfToken(testSecret);
      const isValid = verifyCsrfToken(token, testSecret);

      expect(isValid).toBe(true);
    });

    it("should verify multiple tokens generated with same secret", () => {
      const token1 = generateCsrfToken(testSecret);
      const token2 = generateCsrfToken(testSecret);

      expect(verifyCsrfToken(token1, testSecret)).toBe(true);
      expect(verifyCsrfToken(token2, testSecret)).toBe(true);
    });
  });

  describe("verifyCsrfToken - Negative Cases", () => {
    it("should reject token with wrong secret", () => {
      const token = generateCsrfToken(testSecret);
      const isValid = verifyCsrfToken(token, "wrong-secret");

      expect(isValid).toBe(false);
    });

    it("should reject token with tampered signature", () => {
      const token = generateCsrfToken(testSecret);
      const [tokenPart] = token.split(".");
      const tamperedToken = `${tokenPart}.0000000000000000000000000000000000000000000000000000000000000000`;

      const isValid = verifyCsrfToken(tamperedToken, testSecret);

      expect(isValid).toBe(false);
    });

    it("should reject token with invalid format (no signature)", () => {
      const invalidToken = "abc123";
      const isValid = verifyCsrfToken(invalidToken, testSecret);

      expect(isValid).toBe(false);
    });

    it("should reject token with too many parts", () => {
      const invalidToken = "part1.part2.part3";
      const isValid = verifyCsrfToken(invalidToken, testSecret);

      expect(isValid).toBe(false);
    });

    it("should reject empty token", () => {
      const isValid = verifyCsrfToken("", testSecret);

      expect(isValid).toBe(false);
    });

    it("should reject token with non-hex characters", () => {
      const invalidToken = "gggggggg.hhhhhhhh";
      const isValid = verifyCsrfToken(invalidToken, testSecret);

      expect(isValid).toBe(false);
    });
  });
});

describe("Origin/Referer Header Validation", () => {
  describe("validateOrigin - Positive Cases", () => {
    it("should allow same-origin requests", () => {
      const isValid = validateOrigin(
        "https://example.com",
        ["same-origin"],
        "example.com"
      );

      expect(isValid).toBe(true);
    });

    it("should allow explicitly whitelisted origin", () => {
      const isValid = validateOrigin(
        "https://app.example.com",
        ["https://app.example.com"],
        "api.example.com"
      );

      expect(isValid).toBe(true);
    });

    it("should allow origin from multiple whitelisted origins", () => {
      const allowedOrigins = [
        "https://app1.example.com",
        "https://app2.example.com",
        "https://app3.example.com",
      ];

      expect(validateOrigin("https://app2.example.com", allowedOrigins, "api.example.com")).toBe(true);
    });

    it("should handle origin with port numbers (same-origin)", () => {
      const isValid = validateOrigin(
        "https://example.com:8080",
        ["same-origin"],
        "example.com:8080"
      );

      expect(isValid).toBe(true);
    });

    it("should handle origin with port numbers (explicit whitelist)", () => {
      const isValid = validateOrigin(
        "https://example.com:8080",
        ["https://example.com:8080"],
        "api.example.com"
      );

      expect(isValid).toBe(true);
    });
  });

  describe("validateOrigin - Negative Cases", () => {
    it("should reject missing origin header", () => {
      const isValid = validateOrigin(
        undefined,
        ["same-origin"],
        "example.com"
      );

      expect(isValid).toBe(false);
    });

    it("should reject origin not in whitelist", () => {
      const isValid = validateOrigin(
        "https://evil.com",
        ["https://trusted.com"],
        "api.example.com"
      );

      expect(isValid).toBe(false);
    });

    it("should reject cross-origin when same-origin is required", () => {
      const isValid = validateOrigin(
        "https://attacker.com",
        ["same-origin"],
        "example.com"
      );

      expect(isValid).toBe(false);
    });

    it("should reject when request host is missing (same-origin check)", () => {
      const isValid = validateOrigin(
        "https://example.com",
        ["same-origin"],
        undefined
      );

      expect(isValid).toBe(false);
    });

    it("should reject origin with different port (same-origin)", () => {
      const isValid = validateOrigin(
        "https://example.com:8080",
        ["same-origin"],
        "example.com:9090"
      );

      expect(isValid).toBe(false);
    });

    it("should reject origin with different protocol (explicit whitelist)", () => {
      const isValid = validateOrigin(
        "http://example.com",
        ["https://example.com"],
        "api.example.com"
      );

      expect(isValid).toBe(false);
    });

    it("should reject subdomain when parent domain is whitelisted", () => {
      const isValid = validateOrigin(
        "https://sub.example.com",
        ["https://example.com"],
        "api.example.com"
      );

      expect(isValid).toBe(false);
    });

    it("should reject invalid origin URL", () => {
      const isValid = validateOrigin(
        "not-a-valid-url",
        ["same-origin"],
        "example.com"
      );

      expect(isValid).toBe(false);
    });
  });
});

describe("WebSocket Origin Validation", () => {
  const testConfig: CsrfConfig = {
    allowedOrigins: ["https://trusted.com"],
    cookieName: "XSRF-TOKEN",
    headerName: "x-csrf-token",
    signingSecret: "test-secret",
    enabled: true,
  };

  describe("validateWebSocketOrigin - Positive Cases", () => {
    it("should allow WebSocket connection from trusted origin", () => {
      const isValid = validateWebSocketOrigin(
        "https://trusted.com",
        testConfig,
        "ws.example.com"
      );

      expect(isValid).toBe(true);
    });

    it("should allow WebSocket connection when same-origin", () => {
      const configSameOrigin: CsrfConfig = {
        ...testConfig,
        allowedOrigins: ["same-origin"],
      };

      const isValid = validateWebSocketOrigin(
        "https://example.com",
        configSameOrigin,
        "example.com"
      );

      expect(isValid).toBe(true);
    });

    it("should allow WebSocket connection when CSRF protection is disabled", () => {
      const configDisabled: CsrfConfig = {
        ...testConfig,
        enabled: false,
      };

      const isValid = validateWebSocketOrigin(
        "https://evil.com",
        configDisabled,
        "ws.example.com"
      );

      expect(isValid).toBe(true);
    });
  });

  describe("validateWebSocketOrigin - Negative Cases", () => {
    it("should reject WebSocket connection without Origin header", () => {
      const isValid = validateWebSocketOrigin(
        undefined,
        testConfig,
        "ws.example.com"
      );

      expect(isValid).toBe(false);
    });

    it("should reject WebSocket connection from untrusted origin", () => {
      const isValid = validateWebSocketOrigin(
        "https://evil.com",
        testConfig,
        "ws.example.com"
      );

      expect(isValid).toBe(false);
    });

    it("should reject WebSocket connection from different subdomain", () => {
      const configSameOrigin: CsrfConfig = {
        ...testConfig,
        allowedOrigins: ["same-origin"],
      };

      const isValid = validateWebSocketOrigin(
        "https://attacker.example.com",
        configSameOrigin,
        "ws.example.com"
      );

      expect(isValid).toBe(false);
    });
  });
});

describe("CSRF Protection Middleware", () => {
  let app: Express;
  const testSecret = "test-secret-for-middleware";
  const testConfig: CsrfConfig = {
    allowedOrigins: ["same-origin"],
    cookieName: "XSRF-TOKEN",
    headerName: "x-csrf-token",
    signingSecret: testSecret,
    enabled: true,
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(cookieParser());

    // Test endpoint that requires CSRF protection
    app.post("/protected", csrfProtection(testConfig), (_req: Request, res: Response) => {
      res.json({ success: true });
    });

    // Test endpoint for GET (should not require CSRF protection)
    app.get("/protected", csrfProtection(testConfig), (_req: Request, res: Response) => {
      res.json({ success: true });
    });
  });

  describe("CSRF Middleware - Positive Cases", () => {
    it("should allow GET requests without CSRF token", async () => {
      const response = await request(app)
        .get("/protected")
        .set("Origin", "https://example.com")
        .set("Host", "example.com");

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should allow HEAD requests without CSRF token", async () => {
      const response = await request(app)
        .head("/protected")
        .set("Origin", "https://example.com")
        .set("Host", "example.com");

      expect(response.status).toBe(200);
    });

    it("should allow POST request with valid CSRF token", async () => {
      const token = generateCsrfToken(testSecret);

      const response = await request(app)
        .post("/protected")
        .set("Origin", "https://example.com")
        .set("Host", "example.com")
        .set("x-csrf-token", token)
        .set("Cookie", `XSRF-TOKEN=${token}`)
        .send({ data: "test" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should allow PUT request with valid CSRF token", async () => {
      const token = generateCsrfToken(testSecret);

      app.put("/protected", csrfProtection(testConfig), (_req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .put("/protected")
        .set("Origin", "https://example.com")
        .set("Host", "example.com")
        .set("x-csrf-token", token)
        .set("Cookie", `XSRF-TOKEN=${token}`)
        .send({ data: "test" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should allow PATCH request with valid CSRF token", async () => {
      const token = generateCsrfToken(testSecret);

      app.patch("/protected", csrfProtection(testConfig), (_req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .patch("/protected")
        .set("Origin", "https://example.com")
        .set("Host", "example.com")
        .set("x-csrf-token", token)
        .set("Cookie", `XSRF-TOKEN=${token}`)
        .send({ data: "test" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should allow DELETE request with valid CSRF token", async () => {
      const token = generateCsrfToken(testSecret);

      app.delete("/protected", csrfProtection(testConfig), (_req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .delete("/protected")
        .set("Origin", "https://example.com")
        .set("Host", "example.com")
        .set("x-csrf-token", token)
        .set("Cookie", `XSRF-TOKEN=${token}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should allow request with Referer header instead of Origin", async () => {
      const token = generateCsrfToken(testSecret);

      const response = await request(app)
        .post("/protected")
        .set("Referer", "https://example.com/page")
        .set("Host", "example.com")
        .set("x-csrf-token", token)
        .set("Cookie", `XSRF-TOKEN=${token}`)
        .send({ data: "test" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe("CSRF Middleware - Negative Cases", () => {
    it("should reject POST request without CSRF token in header", async () => {
      const token = generateCsrfToken(testSecret);

      const response = await request(app)
        .post("/protected")
        .set("Origin", "https://example.com")
        .set("Host", "example.com")
        .set("Cookie", `XSRF-TOKEN=${token}`)
        .send({ data: "test" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("CSRF_TOKEN_MISSING");
    });

    it("should reject POST request without CSRF token in cookie", async () => {
      const token = generateCsrfToken(testSecret);

      const response = await request(app)
        .post("/protected")
        .set("Origin", "https://example.com")
        .set("Host", "example.com")
        .set("x-csrf-token", token)
        .send({ data: "test" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("CSRF_COOKIE_MISSING");
    });

    it("should reject POST request with mismatched tokens", async () => {
      const token1 = generateCsrfToken(testSecret);
      const token2 = generateCsrfToken(testSecret);

      const response = await request(app)
        .post("/protected")
        .set("Origin", "https://example.com")
        .set("Host", "example.com")
        .set("x-csrf-token", token1)
        .set("Cookie", `XSRF-TOKEN=${token2}`)
        .send({ data: "test" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("CSRF_TOKEN_MISMATCH");
    });

    it("should reject POST request with invalid token signature", async () => {
      const invalidToken = "abc123.def456";

      const response = await request(app)
        .post("/protected")
        .set("Origin", "https://example.com")
        .set("Host", "example.com")
        .set("x-csrf-token", invalidToken)
        .set("Cookie", `XSRF-TOKEN=${invalidToken}`)
        .send({ data: "test" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("CSRF_INVALID_SIGNATURE");
    });

    it("should reject POST request with invalid origin", async () => {
      const token = generateCsrfToken(testSecret);

      const response = await request(app)
        .post("/protected")
        .set("Origin", "https://evil.com")
        .set("Host", "example.com")
        .set("x-csrf-token", token)
        .set("Cookie", `XSRF-TOKEN=${token}`)
        .send({ data: "test" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("CSRF_INVALID_ORIGIN");
    });

    it("should reject POST request without origin or referer header", async () => {
      const token = generateCsrfToken(testSecret);

      const response = await request(app)
        .post("/protected")
        .set("Host", "example.com")
        .set("x-csrf-token", token)
        .set("Cookie", `XSRF-TOKEN=${token}`)
        .send({ data: "test" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("CSRF_INVALID_ORIGIN");
    });

    it("should reject POST request with token signed with different secret", async () => {
      const token = generateCsrfToken("different-secret");

      const response = await request(app)
        .post("/protected")
        .set("Origin", "https://example.com")
        .set("Host", "example.com")
        .set("x-csrf-token", token)
        .set("Cookie", `XSRF-TOKEN=${token}`)
        .send({ data: "test" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("CSRF_INVALID_SIGNATURE");
    });
  });

  describe("CSRF Middleware - Disabled Protection", () => {
    it("should allow requests when CSRF protection is disabled", async () => {
      const disabledConfig: CsrfConfig = {
        ...testConfig,
        enabled: false,
      };

      const disabledApp = express();
      disabledApp.use(express.json());
      disabledApp.post("/test", csrfProtection(disabledConfig), (_req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(disabledApp)
        .post("/test")
        .send({ data: "test" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });
});

describe("CSRF Token Endpoint", () => {
  let app: Express;
  const testSecret = "test-secret-for-endpoint";
  const testConfig: CsrfConfig = {
    allowedOrigins: ["same-origin"],
    cookieName: "XSRF-TOKEN",
    headerName: "x-csrf-token",
    signingSecret: testSecret,
    enabled: true,
  };

  beforeEach(() => {
    app = express();
    app.use(cookieParser());
    app.get("/csrf-token", csrfTokenEndpoint(testConfig));
  });

  describe("CSRF Token Endpoint - Positive Cases", () => {
    it("should return a valid CSRF token", async () => {
      const response = await request(app).get("/csrf-token");

      expect(response.status).toBe(200);
      expect(response.body.token).toBeDefined();
      expect(response.body.headerName).toBe("x-csrf-token");
      expect(response.body.token).toMatch(/^[a-f0-9]{64}\.[a-f0-9]{64}$/);
    });

    it("should set CSRF token in cookie", async () => {
      const response = await request(app).get("/csrf-token");

      expect(response.status).toBe(200);
      expect(response.headers["set-cookie"]).toBeDefined();

      const cookieHeader = response.headers["set-cookie"] as string[];
      const csrfCookie = cookieHeader.find((c: string) => c.startsWith("XSRF-TOKEN="));

      expect(csrfCookie).toBeDefined();
      expect(csrfCookie).toContain("SameSite=Strict");
    });

    it("should return different tokens on each request", async () => {
      const response1 = await request(app).get("/csrf-token");
      const response2 = await request(app).get("/csrf-token");

      expect(response1.body.token).not.toBe(response2.body.token);
    });

    it("should return token that can be verified", async () => {
      const response = await request(app).get("/csrf-token");
      const token = response.body.token;

      const isValid = verifyCsrfToken(token, testSecret);
      expect(isValid).toBe(true);
    });
  });
});
