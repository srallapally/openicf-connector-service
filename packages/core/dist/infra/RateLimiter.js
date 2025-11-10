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
export class RateLimiter {
    tokens;
    lastRefillTime;
    maxTokens;
    refillRate; // tokens per second
    violationCount = 0;
    /**
     * Create a new rate limiter
     * @param maxTokens - Maximum bucket capacity (allows bursts). Default: 20
     * @param refillRate - Tokens added per second. Default: 5 (= 300/min like HTTP)
     */
    constructor(maxTokens = 20, refillRate = 5) {
        this.maxTokens = maxTokens;
        this.refillRate = refillRate;
        this.tokens = maxTokens; // Start with full bucket
        this.lastRefillTime = Date.now();
    }
    /**
     * Refill tokens based on elapsed time since last refill
     * Security: Ensures smooth rate limiting without sudden spikes
     */
    refill() {
        const now = Date.now();
        const elapsedMs = now - this.lastRefillTime;
        const elapsedSec = elapsedMs / 1000;
        // Calculate tokens to add based on elapsed time
        const tokensToAdd = elapsedSec * this.refillRate;
        // Security: Cap at maxTokens to prevent token accumulation
        this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
        this.lastRefillTime = now;
    }
    /**
     * Attempt to consume tokens for an operation
     * @param cost - Number of tokens required (default: 1)
     * @returns true if operation is allowed, false if rate limited
     */
    tryConsume(cost = 1) {
        // Refill tokens before checking availability
        this.refill();
        // Security: Reject if insufficient tokens
        if (this.tokens < cost) {
            this.violationCount++;
            return false;
        }
        // Consume tokens and allow operation
        this.tokens -= cost;
        return true;
    }
    /**
     * Get current token count (for monitoring/debugging)
     */
    getAvailableTokens() {
        this.refill();
        return Math.floor(this.tokens);
    }
    /**
     * Get total number of rate limit violations
     * Security: Useful for monitoring abusive behavior
     */
    getViolationCount() {
        return this.violationCount;
    }
    /**
     * Reset the rate limiter (useful for testing)
     */
    reset() {
        this.tokens = this.maxTokens;
        this.lastRefillTime = Date.now();
        this.violationCount = 0;
    }
}
//# sourceMappingURL=RateLimiter.js.map