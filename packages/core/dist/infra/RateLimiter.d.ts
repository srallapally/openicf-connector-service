/**
 * Token Bucket Rate Limiter
 *
 * Security: Implements message-level rate limiting for WebSocket connections
 * to prevent abuse by authenticated attackers spamming operations.
 *
 * Algorithm: Token bucket allows for burst traffic while enforcing average rate.
 * - Tokens are added at a constant rate (refillRate per second)
 * - Each operation consumes tokens based on its weight
 * - When tokens are exhausted, operations are rate limited
 *
 * Configuration matches HTTP rate limiting: 300 req/min = 5 tokens/sec
 */
export declare class RateLimiter {
    private tokens;
    private lastRefillTime;
    private readonly maxTokens;
    private readonly refillRate;
    private violationCount;
    /**
     * Create a new rate limiter
     * @param maxTokens - Maximum bucket capacity (allows bursts). Default: 20
     * @param refillRate - Tokens added per second. Default: 5 (= 300/min like HTTP)
     */
    constructor(maxTokens?: number, refillRate?: number);
    /**
     * Refill tokens based on elapsed time since last refill
     * Security: Ensures smooth rate limiting without sudden spikes
     */
    private refill;
    /**
     * Attempt to consume tokens for an operation
     * @param cost - Number of tokens required (default: 1)
     * @returns true if operation is allowed, false if rate limited
     */
    tryConsume(cost?: number): boolean;
    /**
     * Get current token count (for monitoring/debugging)
     */
    getAvailableTokens(): number;
    /**
     * Get total number of rate limit violations
     * Security: Useful for monitoring abusive behavior
     */
    getViolationCount(): number;
    /**
     * Reset the rate limiter (useful for testing)
     */
    reset(): void;
}
//# sourceMappingURL=RateLimiter.d.ts.map