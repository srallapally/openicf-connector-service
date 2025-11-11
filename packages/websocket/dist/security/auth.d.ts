import { NextFunction, Request, Response } from "express";
import { JWTPayload } from "jose";
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
export declare class TokenReplayCache {
    private maxSize;
    private cache;
    constructor(maxSize?: number);
    /**
     * Check if a token identifier has been seen before (replay detection)
     */
    has(identifier: string): boolean;
    /**
     * Store a token identifier with TTL based on token expiry
     * @param identifier - Token unique identifier (JTI or fallback hash)
     * @param expEpochSec - Token expiration time in seconds since epoch
     */
    put(identifier: string, expEpochSec: number): void;
    /**
     * Get current cache size for monitoring
     */
    size(): number;
    /**
     * Clear all entries (useful for testing)
     */
    clear(): void;
}
export declare const JtiCache: typeof TokenReplayCache;
export type JtiCache = TokenReplayCache;
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
 * Validates JWT environment variables and returns typed configuration.
 * Performs early validation with specific error messages for each issue.
 *
 * Security: Fail-fast approach prevents service starting with invalid auth config.
 *
 * @throws {Error} If any required variable is missing or invalid
 * @returns {JwtConfig} Validated JWT configuration
 */
export declare function validateJwtConfig(): JwtConfig;
export interface AuthContext {
    sub: string;
    scopes: string[];
    token: string;
    payload: JWTPayload;
}
declare global {
    namespace Express {
        interface Request {
            auth?: AuthContext;
        }
    }
}
export declare function requireJwt(requiredScopes?: string | string[]): Promise<(req: Request, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>>;
//# sourceMappingURL=auth.d.ts.map