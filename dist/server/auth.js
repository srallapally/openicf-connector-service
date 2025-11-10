import { createRemoteJWKSet, jwtVerify, errors as JoseErrors } from "jose";
import { URL } from "url";
import { LRUCache } from "lru-cache";
/**
 * JTI (JWT ID) cache for replay attack prevention.
 * Uses LRU cache with bounded size to prevent memory exhaustion DoS.
 *
 * Security: Max 10,000 entries prevents unbounded memory growth.
 * TTL is calculated per-token based on exp claim for efficient cleanup.
 */
export class JtiCache {
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
     * Check if a JTI has been seen before (replay detection)
     */
    has(jti) {
        return this.cache.has(jti);
    }
    /**
     * Store a JTI with TTL based on token expiry
     * @param jti - JWT ID claim
     * @param expEpochSec - Token expiration time in seconds since epoch
     */
    put(jti, expEpochSec) {
        const now = Math.floor(Date.now() / 1000);
        const ttlSeconds = expEpochSec - now;
        // Only store if token hasn't expired yet
        if (ttlSeconds > 0) {
            this.cache.set(jti, true, { ttl: ttlSeconds * 1000 });
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
const jtiCache = new JtiCache();
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
            const jti = payload.jti;
            if (jti) {
                if (jtiCache.has(jti))
                    return res.status(401).json({ error: "Replay detected" });
                jtiCache.put(jti, exp);
            }
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
