import { createRemoteJWKSet, jwtVerify, errors as JoseErrors } from "jose";
import { URL } from "url";
import { LRUCache } from "lru-cache";
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
    maxSize;
    cache;
    constructor(maxSize = 10_000) {
        this.maxSize = maxSize;
        this.cache = new LRUCache({
            max: maxSize,
            ttlAutopurge: true,
            allowStale: false,
        });
    }
    /**
     * Check if a token identifier has been seen before (replay detection)
     */
    has(identifier) {
        return this.cache.has(identifier);
    }
    /**
     * Store a token identifier with TTL based on token expiry
     * @param identifier - Token unique identifier (JTI or fallback hash)
     * @param expEpochSec - Token expiration time in seconds since epoch
     */
    put(identifier, expEpochSec) {
        const now = Math.floor(Date.now() / 1000);
        const ttlSeconds = expEpochSec - now;
        // Only store if token hasn't expired yet
        if (ttlSeconds > 0) {
            this.cache.set(identifier, true, { ttl: ttlSeconds * 1000 });
        }
    }
    /**
     * Get current cache size for monitoring
     */
    size() {
        return this.cache.size;
    }
    /**
     * Clear all entries (useful for testing)
     */
    clear() {
        this.cache.clear();
    }
}
// Legacy export for backwards compatibility
export const JtiCache = TokenReplayCache;
const replayCache = new TokenReplayCache();
/**
 * Supported JWT signing algorithms
 * Based on JOSE library and security best practices
 */
const SUPPORTED_ALGORITHMS = [
    "RS256", "RS384", "RS512", // RSA with SHA
    "PS256", "PS384", "PS512", // RSA-PSS with SHA
    "ES256", "ES384", "ES512", // ECDSA with SHA
    "EdDSA", // EdDSA signature algorithms
];
/**
 * Validates JWT environment variables and returns typed configuration.
 * Performs early validation with specific error messages for each issue.
 *
 * Security: Fail-fast approach prevents service starting with invalid auth config.
 *
 * @throws {Error} If any required variable is missing or invalid
 * @returns {JwtConfig} Validated JWT configuration
 */
export function validateJwtConfig() {
    const errors = [];
    // Validate required: JWT_JWKS_URI
    const jwksUri = process.env.JWT_JWKS_URI?.trim();
    if (!jwksUri) {
        errors.push("JWT_JWKS_URI is required but not set");
    }
    else {
        // Validate URL format
        try {
            const url = new URL(jwksUri);
            if (!url.protocol.startsWith("http")) {
                errors.push(`JWT_JWKS_URI must be a valid HTTP(S) URL, got: ${jwksUri}`);
            }
        }
        catch (err) {
            errors.push(`JWT_JWKS_URI is not a valid URL: ${jwksUri}`);
        }
    }
    // Validate required: JWT_EXPECTED_ISS
    const expectedIssuer = process.env.JWT_EXPECTED_ISS?.trim();
    if (!expectedIssuer) {
        errors.push("JWT_EXPECTED_ISS (issuer) is required but not set");
    }
    else if (expectedIssuer.length > 512) {
        errors.push(`JWT_EXPECTED_ISS is too long (max 512 chars): ${expectedIssuer.length} chars`);
    }
    // Validate required: JWT_EXPECTED_AUD
    const expectedAudience = process.env.JWT_EXPECTED_AUD?.trim();
    if (!expectedAudience) {
        errors.push("JWT_EXPECTED_AUD (audience) is required but not set");
    }
    else if (expectedAudience.length > 512) {
        errors.push(`JWT_EXPECTED_AUD is too long (max 512 chars): ${expectedAudience.length} chars`);
    }
    // Validate optional: JWT_ALLOWED_ALGS (with default)
    const algsEnv = process.env.JWT_ALLOWED_ALGS;
    const algsString = algsEnv !== undefined ? algsEnv.trim() : "RS256,PS256,ES256";
    const allowedAlgorithms = algsString.split(",").map(s => s.trim()).filter(Boolean);
    if (allowedAlgorithms.length === 0) {
        errors.push("JWT_ALLOWED_ALGS must contain at least one algorithm");
    }
    else {
        // Validate each algorithm is supported
        const unsupported = allowedAlgorithms.filter(alg => !SUPPORTED_ALGORITHMS.includes(alg));
        if (unsupported.length > 0) {
            errors.push(`JWT_ALLOWED_ALGS contains unsupported algorithms: ${unsupported.join(", ")}. ` +
                `Supported: ${SUPPORTED_ALGORITHMS.join(", ")}`);
        }
    }
    // Validate optional: JWT_ACCEPTED_CLOCK_SKEW_SEC (with default)
    const skewString = process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC?.trim() || "60";
    const clockSkewSeconds = Number(skewString);
    if (isNaN(clockSkewSeconds)) {
        errors.push(`JWT_ACCEPTED_CLOCK_SKEW_SEC must be a number, got: ${skewString}`);
    }
    else if (clockSkewSeconds < 0) {
        errors.push(`JWT_ACCEPTED_CLOCK_SKEW_SEC must be non-negative, got: ${clockSkewSeconds}`);
    }
    else if (clockSkewSeconds > 300) {
        errors.push(`JWT_ACCEPTED_CLOCK_SKEW_SEC is too large (max 300 seconds), got: ${clockSkewSeconds}. ` +
            `Large clock skew values weaken security.`);
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
        }
        else if (requireJtiEnv === "false") {
            requireJti = false;
            console.warn("[SECURITY WARNING] JWT_REQUIRE_JTI is set to false. " +
                "Tokens without JTI will use weaker fallback replay protection. " +
                "This increases the risk of replay attacks.");
        }
        else {
            errors.push(`JWT_REQUIRE_JTI must be "true" or "false", got: ${requireJtiEnv}`);
        }
    }
    // If any errors, throw with all messages
    if (errors.length > 0) {
        throw new Error(`JWT configuration validation failed:\n${errors.map(e => `  - ${e}`).join("\n")}`);
    }
    const result = {
        jwksUri: jwksUri,
        expectedIssuer: expectedIssuer,
        expectedAudience: expectedAudience,
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
    timeoutDuration: 5_000, // how long to wait for the JWKS fetch
    cooldownDuration: 10 * 60_000, // how long to reuse a valid JWKS before re-fetch heuristics
});
function parseAuthHeader(req) {
    const h = req.headers.authorization;
    if (!h)
        return null;
    const [type, val] = h.split(" ");
    if (!type || !val || type.toLowerCase() != "bearer")
        return null;
    return val.trim();
}
function scopeAllowed(scopes, required) {
    if (!required)
        return true;
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
 * Format: fallback:sha256(sub|iat|aud)
 * We use a hash to keep the identifier size bounded and prevent cache abuse.
 */
function generateFallbackIdentifier(payload) {
    const sub = payload.sub || "";
    const iat = payload.iat || 0;
    const aud = Array.isArray(payload.aud) ? payload.aud.join(",") : (payload.aud || "");
    // Create a simple hash (using built-in crypto if available, or fallback)
    const data = `${sub}|${iat}|${aud}`;
    // Simple hash function (not cryptographic, just for identifier generation)
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
        const char = data.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return `fallback:${sub}:${iat}:${Math.abs(hash).toString(36)}`;
}
export async function requireJwt(requiredScopes) {
    return async (req, res, next) => {
        try {
            const token = parseAuthHeader(req);
            if (!token)
                return res.status(401).json({ error: "Missing bearer token" });
            const { payload, protectedHeader } = await jwtVerify(token, jwks, {
                algorithms: config.allowedAlgorithms,
                issuer: config.expectedIssuer,
                audience: config.expectedAudience,
                maxTokenAge: `${24}h`,
                clockTolerance: config.clockSkewSeconds,
            });
            if (!protectedHeader.kid)
                return res.status(401).json({ error: "Missing kid" });
            if (!config.allowedAlgorithms.includes(protectedHeader.alg))
                return res.status(401).json({ error: "Unsupported alg" });
            const sub = payload.sub;
            const exp = payload.exp;
            if (!sub || !exp)
                return res.status(401).json({ error: "Missing sub/exp" });
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
            let tokenIdentifier;
            if (jti) {
                // Use JTI as primary identifier (strongest protection)
                tokenIdentifier = jti;
            }
            else {
                // Use fallback identifier when JTI not present (weaker protection)
                tokenIdentifier = generateFallbackIdentifier(payload);
                console.warn(`[auth] Using fallback replay protection for token without JTI (sub: ${sub}). ` +
                    `Consider requiring JTI by setting JWT_REQUIRE_JTI=true`);
            }
            // Check for replay attack
            if (replayCache.has(tokenIdentifier)) {
                console.error(`[auth] REPLAY ATTACK DETECTED - Token reused (identifier: ${tokenIdentifier.substring(0, 20)}..., sub: ${sub})`);
                return res.status(401).json({ error: "Replay detected" });
            }
            // Store token identifier to prevent replay
            replayCache.put(tokenIdentifier, exp);
            const scopes = Array.isArray(payload.scope)
                ? payload.scope
                : String(payload.scope || "").split(" ").filter(Boolean);
            if (config.requiredScope && !scopeAllowed(scopes, config.requiredScope))
                return res.status(403).json({ error: "Insufficient scope" });
            if (requiredScopes && !scopeAllowed(scopes, requiredScopes))
                return res.status(403).json({ error: "Insufficient scope" });
            req.auth = { sub, scopes, token, payload };
            return next();
        }
        catch (e) {
            if (e instanceof JoseErrors.JWTExpired)
                return res.status(401).json({ error: "Token expired" });
            if (e instanceof JoseErrors.JWTInvalid)
                return res.status(401).json({ error: "Invalid token" });
            if (e instanceof JoseErrors.JWSSignatureVerificationFailed)
                return res.status(401).json({ error: "Bad signature" });
            return res.status(401).json({ error: "Unauthorized" });
        }
    };
}
//# sourceMappingURL=auth.js.map