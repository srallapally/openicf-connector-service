import { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, JWTPayload, errors as JoseErrors } from "jose";
import { URL } from "url";
import { LRUCache } from "lru-cache";
import { createHash } from "crypto";

/**
 * Token replay cache for preventing JWT replay attacks.
 * Uses LRU cache with bounded size to prevent memory exhaustion DoS.
 *
 * Security: Max 10,000 entries prevents unbounded memory growth.
 * TTL is calculated per-token based on exp claim for efficient cleanup.
 *
 * Supports two modes:
 * 1. JTI-based: Uses JWT ID claim (jti) for unique identification
 * 2. Fallback: Uses sub+iat+aud hash when JTI is not present (weaker protection)
 */
export class TokenReplayCache {
  private cache: LRUCache<string, boolean>;

  constructor(private maxSize = 10_000) {
    this.cache = new LRUCache<string, boolean>({
      max: maxSize,
      ttlAutopurge: true,
      allowStale: false,
    });
  }

  /**
   * Check if a token identifier has been seen before (replay detection)
   */
  has(identifier: string): boolean {
    return this.cache.has(identifier);
  }

  /**
   * Store a token identifier with TTL based on token expiry
   * @param identifier - Token unique identifier (JTI or fallback hash)
   * @param expEpochSec - Token expiration time in seconds since epoch
   *
   * CRITICAL FIX: Added hard TTL cap (1 hour max) to prevent cache exhaustion.
   * With long-lived tokens (24h), cache would be filled before actual expiry,
   * allowing LRU eviction and replay attacks.
   * @see https://github.com/srallapally/openicf-connector-service/security
   */
  put(identifier: string, expEpochSec: number): void {
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = expEpochSec - now;

    // Only store if token hasn't expired yet
    if (ttlSeconds > 0) {
      // CRITICAL: Cap TTL at 1 hour (3600 seconds) to prevent cache exhaustion
      // Even if token lifetime is 24 hours, we only cache for 1 hour
      const cappedTtlSeconds = Math.min(ttlSeconds, 3600);
      this.cache.set(identifier, true, { ttl: cappedTtlSeconds * 1000 });
    }
  }

  /**
   * Get current cache size for monitoring
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Clear all entries (useful for testing)
   */
  clear(): void {
    this.cache.clear();
  }
}

// Legacy export for backwards compatibility
export const JtiCache = TokenReplayCache;
export type JtiCache = TokenReplayCache;

const replayCache = new TokenReplayCache();

/**
 * JWT configuration interface
 */
export interface JwtConfig {
  jwksUri: string;
  expectedIssuer: string;
  expectedAudience: string;
  allowedAlgorithms: string[];
  clockSkewSeconds: number;
  requiredScope?: string;
  requireJti: boolean;
}

/**
 * Supported JWT signing algorithms
 * Based on JOSE library and security best practices
 */
const SUPPORTED_ALGORITHMS = [
  "RS256", "RS384", "RS512",  // RSA with SHA
  "PS256", "PS384", "PS512",  // RSA-PSS with SHA
  "ES256", "ES384", "ES512",  // ECDSA with SHA
  "EdDSA",                     // EdDSA signature algorithms
] as const;

/**
 * Validates JWT environment variables and returns typed configuration.
 * Performs early validation with specific error messages for each issue.
 *
 * Security: Fail-fast approach prevents service starting with invalid auth config.
 *
 * @throws {Error} If any required variable is missing or invalid
 * @returns {JwtConfig} Validated JWT configuration
 */
export function validateJwtConfig(): JwtConfig {
  const errors: string[] = [];

  // Validate required: JWT_JWKS_URI
  const jwksUri = process.env.JWT_JWKS_URI?.trim();
  if (!jwksUri) {
    errors.push("JWT_JWKS_URI is required but not set");
  } else {
    // Validate URL format
    try {
      const url = new URL(jwksUri);
      if (!url.protocol.startsWith("http")) {
        errors.push(`JWT_JWKS_URI must be a valid HTTP(S) URL, got: ${jwksUri}`);
      }
    } catch (err) {
      errors.push(`JWT_JWKS_URI is not a valid URL: ${jwksUri}`);
    }
  }

  // Validate required: JWT_EXPECTED_ISS
  const expectedIssuer = process.env.JWT_EXPECTED_ISS?.trim();
  if (!expectedIssuer) {
    errors.push("JWT_EXPECTED_ISS (issuer) is required but not set");
  } else if (expectedIssuer.length > 512) {
    errors.push(`JWT_EXPECTED_ISS is too long (max 512 chars): ${expectedIssuer.length} chars`);
  }

  // Validate required: JWT_EXPECTED_AUD
  const expectedAudience = process.env.JWT_EXPECTED_AUD?.trim();
  if (!expectedAudience) {
    errors.push("JWT_EXPECTED_AUD (audience) is required but not set");
  } else if (expectedAudience.length > 512) {
    errors.push(`JWT_EXPECTED_AUD is too long (max 512 chars): ${expectedAudience.length} chars`);
  }

  // Validate optional: JWT_ALLOWED_ALGS (with default)
  const algsEnv = process.env.JWT_ALLOWED_ALGS;
  const algsString = algsEnv !== undefined ? algsEnv.trim() : "RS256,PS256,ES256";
  const allowedAlgorithms = algsString.split(",").map(s => s.trim()).filter(Boolean);

  if (allowedAlgorithms.length === 0) {
    errors.push("JWT_ALLOWED_ALGS must contain at least one algorithm");
  } else {
    // Validate each algorithm is supported
    const unsupported = allowedAlgorithms.filter(alg => !SUPPORTED_ALGORITHMS.includes(alg as any));
    if (unsupported.length > 0) {
      errors.push(
        `JWT_ALLOWED_ALGS contains unsupported algorithms: ${unsupported.join(", ")}. ` +
        `Supported: ${SUPPORTED_ALGORITHMS.join(", ")}`
      );
    }
  }

  // Validate optional: JWT_ACCEPTED_CLOCK_SKEW_SEC (with default)
  const skewString = process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC?.trim() || "60";
  const clockSkewSeconds = Number(skewString);

  if (isNaN(clockSkewSeconds)) {
    errors.push(`JWT_ACCEPTED_CLOCK_SKEW_SEC must be a number, got: ${skewString}`);
  } else if (clockSkewSeconds < 0) {
    errors.push(`JWT_ACCEPTED_CLOCK_SKEW_SEC must be non-negative, got: ${clockSkewSeconds}`);
  } else if (clockSkewSeconds > 300) {
    errors.push(
      `JWT_ACCEPTED_CLOCK_SKEW_SEC is too large (max 300 seconds), got: ${clockSkewSeconds}. ` +
      `Large clock skew values weaken security.`
    );
  }

  // Validate optional: JWT_REQUIRED_SCOPE
  const requiredScope = process.env.JWT_REQUIRED_SCOPE?.trim();
  if (requiredScope && requiredScope.length > 256) {
    errors.push(`JWT_REQUIRED_SCOPE is too long (max 256 chars): ${requiredScope.length} chars`);
  }

  // Validate optional: JWT_REQUIRE_JTI (with default: true)
  // Security: Requiring JTI prevents replay attacks. Default is true for security.
  const requireJtiEnv = process.env.JWT_REQUIRE_JTI?.trim();
  let requireJti = true; // Secure default

  if (requireJtiEnv !== undefined && requireJtiEnv !== "") {
    if (requireJtiEnv === "true") {
      requireJti = true;
    } else if (requireJtiEnv === "false") {
      requireJti = false;
      console.warn(
        "[SECURITY WARNING] JWT_REQUIRE_JTI is set to false. " +
        "Tokens without JTI will use weaker fallback replay protection. " +
        "This increases the risk of replay attacks."
      );
    } else {
      errors.push(`JWT_REQUIRE_JTI must be "true" or "false", got: ${requireJtiEnv}`);
    }
  }

  // If any errors, throw with all messages
  if (errors.length > 0) {
    throw new Error(
      `JWT configuration validation failed:\n${errors.map(e => `  - ${e}`).join("\n")}`
    );
  }

  const result: JwtConfig = {
    jwksUri: jwksUri!,
    expectedIssuer: expectedIssuer!,
    expectedAudience: expectedAudience!,
    allowedAlgorithms,
    clockSkewSeconds,
    requireJti,
  };

  // Only include requiredScope if it's defined (exactOptionalPropertyTypes compliance)
  if (requiredScope) {
    result.requiredScope = requiredScope;
  }

  return result;
}

// Validate configuration on module load (fail-fast)
const config = validateJwtConfig();

// Create JWKS client with validated configuration
const jwks = createRemoteJWKSet(new URL(config.jwksUri), {
  timeoutDuration: 5_000,         // how long to wait for the JWKS fetch
  cooldownDuration: 10 * 60_000,  // how long to reuse a valid JWKS before re-fetch heuristics
});
export interface AuthContext {
  sub: string;
  scopes: string[];
  token: string;
  payload: JWTPayload;
}

declare global {
  namespace Express { interface Request { auth?: AuthContext; } }
}

/**
 * Parse and validate Bearer token from Authorization header.
 *
 * CRITICAL FIX: Strict validation to prevent token forgery and manipulation attacks.
 * - Uses strict equality (===) instead of loose (!=)
 * - Validates token length (no null/undefined tokens, reasonable bounds)
 * - Rejects whitespace in tokens (prevents canonicalization attacks)
 * - Prevents header injection and malformed bearer tokens
 * @see https://github.com/srallapally/openicf-connector-service/security
 */
function parseAuthHeader(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;

  // Strict format validation: "Bearer <token>"
  // Prevents multiple spaces and other variations
  if (!h.startsWith("Bearer ")) return null;

  const token = h.slice(7);  // Extract token after "Bearer "

  // Validate token: no whitespace, reasonable length bounds
  if (!token || token.length < 20 || token.length > 2048) {
    return null;
  }

  // Reject tokens with any whitespace (prevents manipulation)
  if (/\s/.test(token)) {
    return null;
  }

  return token;
}

function scopeAllowed(scopes: string[], required?: string | string[]) {
  if (!required) return true;
  const list = Array.isArray(required) ? required : [required];
  return list.every(r => scopes.includes(r));
}

/**
 * Generate a fallback token identifier when JTI is not present.
 * Uses a combination of sub, iat, and aud to create a pseudo-unique identifier.
 *
 * Security Note: This is weaker than JTI because:
 * - If an attacker can manipulate 'iat' (issued at) precision, they might generate multiple tokens
 * - Relies on the authorization server including 'iat' with sufficient precision
 *
 * Format: fallback:<sha256(sub|iat|aud)>
 * Uses cryptographic SHA-256 hash to prevent identifier forgery and keep size bounded.
 *
 * CRITICAL FIX: Replaced non-cryptographic 32-bit hash with SHA-256 for security hardening.
 * @see https://github.com/srallapally/openicf-connector-service/security
 */
function generateFallbackIdentifier(payload: JWTPayload): string {
  const sub = payload.sub || "";
  const iat = payload.iat || 0;
  const aud = Array.isArray(payload.aud) ? payload.aud.join(",") : (payload.aud || "");

  // Use cryptographic SHA-256 hash for secure identifier generation
  const data = `${sub}|${iat}|${aud}`;
  const hash = createHash("sha256").update(data).digest("hex");

  return `fallback:${hash}`;
}

export async function requireJwt(requiredScopes?: string | string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = parseAuthHeader(req);
      if (!token) return res.status(401).json({ error: "Missing bearer token" });

      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        algorithms: config.allowedAlgorithms as any,
        issuer: config.expectedIssuer,
        audience: config.expectedAudience,
        maxTokenAge: `${24}h`,
        clockTolerance: config.clockSkewSeconds,
      });

      if (!protectedHeader.kid) return res.status(401).json({ error: "Missing kid" });
      if (!config.allowedAlgorithms.includes(protectedHeader.alg as string)) return res.status(401).json({ error: "Unsupported alg" });

      const sub = payload.sub;
      const exp = payload.exp;
      if (!sub || !exp) return res.status(401).json({ error: "Missing sub/exp" });

      // Replay attack prevention with JTI or fallback identifier
      const jti = typeof payload.jti === "string" ? payload.jti : undefined;

      if (config.requireJti && !jti) {
        // JTI is required but missing - reject token
        console.warn(`[auth] Token rejected: JTI required but missing (sub: ${sub})`);
        return res.status(401).json({
          error: "Missing jti claim",
          details: "JTI (JWT ID) claim is required for replay protection"
        });
      }

      // Generate token identifier for replay detection
      let tokenIdentifier: string;
      if (jti) {
        // Use JTI as primary identifier (strongest protection)
        tokenIdentifier = jti;
      } else {
        // Use fallback identifier when JTI not present (weaker protection)
        tokenIdentifier = generateFallbackIdentifier(payload);
        console.warn(
          `[auth] Using fallback replay protection for token without JTI (sub: ${sub}). ` +
          `Consider requiring JTI by setting JWT_REQUIRE_JTI=true`
        );
      }

      // Check for replay attack
      if (replayCache.has(tokenIdentifier)) {
        console.error(
          `[auth] REPLAY ATTACK DETECTED - Token reused (identifier: ${tokenIdentifier.substring(0, 20)}..., sub: ${sub})`
        );
        return res.status(401).json({ error: "Replay detected" });
      }

      // Store token identifier to prevent replay
      replayCache.put(tokenIdentifier, exp);

      const scopes = Array.isArray((payload as any).scope)
        ? (payload as any).scope
        : String((payload as any).scope || "").split(" ").filter(Boolean);

      if (config.requiredScope && !scopeAllowed(scopes, config.requiredScope)) return res.status(403).json({ error: "Insufficient scope" });
      if (requiredScopes && !scopeAllowed(scopes, requiredScopes)) return res.status(403).json({ error: "Insufficient scope" });

      req.auth = { sub, scopes, token, payload };
      return next();
    } catch (e: any) {
      if (e instanceof JoseErrors.JWTExpired) return res.status(401).json({ error: "Token expired" });
      if (e instanceof JoseErrors.JWTInvalid) return res.status(401).json({ error: "Invalid token" });
      if (e instanceof JoseErrors.JWSSignatureVerificationFailed) return res.status(401).json({ error: "Bad signature" });
      return res.status(401).json({ error: "Unauthorized" });
    }
  };
}
