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
const JWKS_URI = process.env.JWT_JWKS_URI;
const EXPECTED_ISS = process.env.JWT_EXPECTED_ISS;
const EXPECTED_AUD = process.env.JWT_EXPECTED_AUD;
const ALGS = (process.env.JWT_ALLOWED_ALGS || "RS256,PS256,ES256").split(",").map(s => s.trim());
const SKEW = Number(process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC || "60");
const REQUIRED_SCOPE = process.env.JWT_REQUIRED_SCOPE;
if (!JWKS_URI || !EXPECTED_ISS || !EXPECTED_AUD) {
    throw new Error("JWT_JWKS_URI, JWT_EXPECTED_ISS, JWT_EXPECTED_AUD must be set");
}
const jwks = createRemoteJWKSet(new URL(JWKS_URI), {
    // v5 options:
    timeoutDuration: 5_000, // how long to wait for the JWKS fetch
    cooldownDuration: 10 * 60_000, // how long to reuse a valid JWKS before re-fetch heuristics
    // agent / headers / fetcher are also available if you need them
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
                algorithms: ALGS,
                issuer: EXPECTED_ISS,
                audience: EXPECTED_AUD,
                maxTokenAge: `${24}h`,
                clockTolerance: SKEW,
            });
            if (!protectedHeader.kid)
                return res.status(401).json({ error: "Missing kid" });
            if (!ALGS.includes(protectedHeader.alg))
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
            if (REQUIRED_SCOPE && !scopeAllowed(scopes, REQUIRED_SCOPE))
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
