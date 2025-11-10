/**
 * CSRF Protection Module
 *
 * Implements comprehensive Cross-Site Request Forgery (CSRF) protection using:
 * 1. Double-Submit Cookie Pattern - CSRF tokens in both cookie and header
 * 2. Origin/Referer Header Validation - Validates request origin
 * 3. WebSocket Origin Validation - Prevents cross-origin WebSocket attacks
 *
 * Security Design:
 * - Uses cryptographically secure random tokens (32 bytes)
 * - Signed cookies prevent token tampering
 * - Defense-in-depth: multiple validation layers
 * - Configurable allowed origins via environment variables
 */

import { NextFunction, Request, Response } from "express";
import { randomBytes, createHmac, timingSafeEqual } from "crypto";

/**
 * CSRF Configuration
 * Loads and validates CSRF settings from environment variables
 */
export interface CsrfConfig {
  /** List of allowed origins for CSRF validation (e.g., ["https://app.example.com"]) */
  allowedOrigins: string[];
  /** Cookie name for CSRF token storage */
  cookieName: string;
  /** Header name for CSRF token submission */
  headerName: string;
  /** Secret key for signing CSRF tokens */
  signingSecret: string;
  /** Enable CSRF protection (default: true) */
  enabled: boolean;
}

/**
 * Load CSRF configuration from environment variables
 *
 * Environment Variables:
 * - CSRF_ALLOWED_ORIGINS: Comma-separated list of allowed origins (default: "same-origin")
 * - CSRF_SIGNING_SECRET: Secret for signing tokens (required in production)
 * - CSRF_ENABLED: Enable/disable CSRF protection (default: "true")
 *
 * @returns Validated CSRF configuration
 */
export function loadCsrfConfig(): CsrfConfig {
  const allowedOriginsEnv = process.env.CSRF_ALLOWED_ORIGINS?.trim() || "same-origin";
  const allowedOrigins = allowedOriginsEnv
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);

  // CSRF Protection Enhancement: Generate secret if not provided, warn in production
  let signingSecret = process.env.CSRF_SIGNING_SECRET?.trim();
  if (!signingSecret) {
    signingSecret = randomBytes(32).toString("hex");
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[CSRF] WARNING: CSRF_SIGNING_SECRET not set in production. " +
        "Using auto-generated secret. Set CSRF_SIGNING_SECRET for persistent tokens."
      );
    }
  }

  const enabledEnv = process.env.CSRF_ENABLED?.trim() || "true";
  const enabled = enabledEnv === "true";

  if (!enabled) {
    console.warn(
      "[CSRF] WARNING: CSRF protection is DISABLED. " +
      "This should only be used in development environments."
    );
  }

  return {
    allowedOrigins,
    cookieName: "XSRF-TOKEN",
    headerName: "x-csrf-token",
    signingSecret,
    enabled,
  };
}

/**
 * Generate a cryptographically secure CSRF token
 * Returns a signed token in format: token.signature
 *
 * CSRF Protection Enhancement: Uses 32-byte random token with HMAC-SHA256 signature
 *
 * @param secret - Secret key for signing the token
 * @returns Signed CSRF token string
 */
export function generateCsrfToken(secret: string): string {
  // Generate 32 bytes of cryptographically secure random data
  const token = randomBytes(32).toString("hex");

  // Sign the token with HMAC-SHA256 to prevent tampering
  const signature = createHmac("sha256", secret)
    .update(token)
    .digest("hex");

  return `${token}.${signature}`;
}

/**
 * Verify a CSRF token's signature
 * Uses timing-safe comparison to prevent timing attacks
 *
 * CSRF Protection Enhancement: Timing-safe comparison prevents timing attacks
 *
 * @param signedToken - Token in format: token.signature
 * @param secret - Secret key used for signing
 * @returns true if token is valid, false otherwise
 */
export function verifyCsrfToken(signedToken: string, secret: string): boolean {
  const parts = signedToken.split(".");
  if (parts.length !== 2) {
    return false;
  }

  const token = parts[0]!;
  const signature = parts[1]!;

  // Recompute the expected signature
  const expectedSignature = createHmac("sha256", secret)
    .update(token)
    .digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  try {
    const sigBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

/**
 * Validate Origin or Referer header against allowed origins
 *
 * CSRF Protection Enhancement: Validates request origin to prevent cross-site requests
 *
 * @param originHeader - Value of Origin or Referer header
 * @param allowedOrigins - List of allowed origins
 * @param requestHost - Host of the current request (for same-origin check)
 * @returns true if origin is allowed, false otherwise
 */
export function validateOrigin(
  originHeader: string | undefined,
  allowedOrigins: string[],
  requestHost: string | undefined
): boolean {
  if (!originHeader) {
    return false;
  }

  // Special case: "same-origin" means origin must match request host
  if (allowedOrigins.includes("same-origin")) {
    if (!requestHost) {
      return false;
    }

    try {
      const originUrl = new URL(originHeader);
      const requestUrl = new URL(`https://${requestHost}`); // protocol doesn't matter for host comparison

      // Compare host and port
      return originUrl.host === requestUrl.host;
    } catch {
      return false;
    }
  }

  // Check if origin is in allowed list
  return allowedOrigins.some(allowed => {
    try {
      const originUrl = new URL(originHeader);
      const allowedUrl = new URL(allowed);

      // Match full origin (protocol + host + port)
      return originUrl.origin === allowedUrl.origin;
    } catch {
      return false;
    }
  });
}

/**
 * CSRF Token Validation Middleware
 * Validates CSRF tokens on state-changing HTTP requests (POST, PUT, PATCH, DELETE)
 *
 * Security Flow:
 * 1. Skip validation for safe methods (GET, HEAD, OPTIONS)
 * 2. Validate Origin/Referer header
 * 3. Validate CSRF token from header against cookie
 * 4. Reject request if any validation fails
 *
 * CSRF Protection Enhancement: Multi-layered validation (origin + token)
 *
 * @param config - CSRF configuration
 * @returns Express middleware function
 */
export function csrfProtection(config: CsrfConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    // CSRF Protection Enhancement: Skip if disabled (development only)
    if (!config.enabled) {
      return next();
    }

    // Safe methods don't need CSRF protection (they should be idempotent)
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }

    // CSRF Protection Enhancement: Validate Origin/Referer header first
    const origin = req.headers.origin || req.headers.referer;
    const host = req.headers.host;

    if (!validateOrigin(origin, config.allowedOrigins, host)) {
      console.warn(
        `[CSRF] Origin validation failed: origin=${origin}, host=${host}, ` +
        `method=${method}, path=${req.path}`
      );
      return res.status(403).json({
        error: "CSRF validation failed: Invalid origin",
        code: "CSRF_INVALID_ORIGIN",
      });
    }

    // CSRF Protection Enhancement: Validate CSRF token (double-submit cookie pattern)
    const tokenFromHeader = req.headers[config.headerName.toLowerCase()] as string | undefined;
    const tokenFromCookie = req.cookies?.[config.cookieName] as string | undefined;

    if (!tokenFromHeader) {
      console.warn(
        `[CSRF] Token missing from header: method=${method}, path=${req.path}`
      );
      return res.status(403).json({
        error: "CSRF validation failed: Missing CSRF token in header",
        code: "CSRF_TOKEN_MISSING",
      });
    }

    if (!tokenFromCookie) {
      console.warn(
        `[CSRF] Token missing from cookie: method=${method}, path=${req.path}`
      );
      return res.status(403).json({
        error: "CSRF validation failed: Missing CSRF token in cookie",
        code: "CSRF_COOKIE_MISSING",
      });
    }

    // Verify token signature
    if (!verifyCsrfToken(tokenFromHeader, config.signingSecret)) {
      console.warn(
        `[CSRF] Invalid token signature: method=${method}, path=${req.path}`
      );
      return res.status(403).json({
        error: "CSRF validation failed: Invalid token signature",
        code: "CSRF_INVALID_SIGNATURE",
      });
    }

    // Verify tokens match (double-submit pattern)
    if (tokenFromHeader !== tokenFromCookie) {
      console.warn(
        `[CSRF] Token mismatch: method=${method}, path=${req.path}`
      );
      return res.status(403).json({
        error: "CSRF validation failed: Token mismatch",
        code: "CSRF_TOKEN_MISMATCH",
      });
    }

    // All validations passed
    return next();
  };
}

/**
 * CSRF Token Endpoint Middleware
 * Provides endpoint for clients to retrieve CSRF tokens
 * Sets token in cookie and returns it in response
 *
 * Usage: GET /csrf-token
 * Response: { token: "..." }
 *
 * CSRF Protection Enhancement: Clients can retrieve token before making state-changing requests
 *
 * @param config - CSRF configuration
 * @returns Express middleware function
 */
export function csrfTokenEndpoint(config: CsrfConfig) {
  return (req: Request, res: Response) => {
    // Generate new CSRF token
    const token = generateCsrfToken(config.signingSecret);

    // CSRF Protection Enhancement: Set token in HTTP-only, secure cookie
    res.cookie(config.cookieName, token, {
      httpOnly: false, // Must be readable by JavaScript for double-submit pattern
      secure: process.env.NODE_ENV === "production", // HTTPS only in production
      sameSite: "strict", // Strict same-site policy
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    // Return token in response body
    return res.json({
      token,
      headerName: config.headerName,
    });
  };
}

/**
 * Validate WebSocket Origin header during handshake
 * Prevents cross-origin WebSocket connections
 *
 * CSRF Protection Enhancement: Critical protection for WebSocket endpoints
 *
 * @param originHeader - Origin header from WebSocket handshake
 * @param config - CSRF configuration
 * @param requestHost - Host of the request
 * @returns true if origin is valid, false otherwise
 */
export function validateWebSocketOrigin(
  originHeader: string | undefined,
  config: CsrfConfig,
  requestHost: string | undefined
): boolean {
  // CSRF Protection Enhancement: Skip if disabled (development only)
  if (!config.enabled) {
    return true;
  }

  // CSRF Protection Enhancement: Reject if no Origin header present
  if (!originHeader) {
    console.warn("[CSRF] WebSocket connection rejected: Missing Origin header");
    return false;
  }

  // Validate origin against allowed list
  const isValid = validateOrigin(originHeader, config.allowedOrigins, requestHost);

  if (!isValid) {
    console.warn(
      `[CSRF] WebSocket connection rejected: Invalid origin=${originHeader}, ` +
      `host=${requestHost}`
    );
  }

  return isValid;
}
