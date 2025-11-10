# Security: Add WebSocket message-level rate limiting to prevent DoS attacks

## Summary

Implements message-level rate limiting for WebSocket connections to prevent authenticated attackers from spamming operations indefinitely. This fix addresses a critical security vulnerability where WebSocket had NO rate limiting while HTTP endpoints have 300 req/min protection.

## Problem Statement

### Vulnerability
- **HTTP endpoints**: Protected with 300 req/min rate limiting
- **WebSocket connections**: NO rate limiting at all
- **Circuit breaker**: Only limits 20 concurrent operations per facade (not message rate)
- **Impact**: Authenticated attacker can spam operations indefinitely, creating DoS vulnerability

### Attack Scenario
1. Attacker authenticates with valid credentials
2. Establishes WebSocket connection
3. Floods server with unlimited operation messages
4. Server resources exhausted, legitimate users affected
5. Circuit breaker insufficient - only limits concurrency, not rate

## Solution

Implemented **Token Bucket Rate Limiter** matching HTTP protection level:

### Configuration
- **Sustained rate**: 300 messages/min (5 tokens/sec) - matches HTTP
- **Burst capacity**: 20 tokens - allows legitimate traffic spikes
- **Scope**: Per WebSocket connection - prevents single attacker from exhausting global quota

### Message Costs
Different message types have different costs to reflect their resource usage:
- `ping`: 0.5 tokens (lightweight, informational)
- `list-connectors`: 0.5 tokens (lightweight, read-only)
- `operation`: 1 token (expensive, performs actual work)

### Behavior
- **Rate limit exceeded**: Send error response with code `RATE_LIMIT_EXCEEDED`
- **No disconnection**: Graceful handling allows legitimate clients to recover
- **Monitoring**: Logs violations with `[ws-rate-limit]` prefix
- **Metrics**: Tracks violation count for abuse detection

## Implementation Details

### Files Changed

1. **`src/core/RateLimiter.ts`** (NEW)
   - Token bucket algorithm implementation
   - Configurable max tokens and refill rate
   - Violation tracking for monitoring
   - O(1) complexity per request

2. **`src/server/websocket.ts`** (MODIFIED)
   - Import RateLimiter class
   - Add rate limiter instance to RemoteConnectorService
   - Check rate limits in `handleMessage()` before processing
   - Different costs for different message types
   - Send error responses on rate limit

3. **`test/core/RateLimiter.test.ts`** (NEW)
   - 31 comprehensive unit tests
   - Token consumption and refill mechanics
   - Security properties and attack scenarios
   - Edge cases and performance characteristics

4. **`test/server/websocket-rate-limiting.test.ts`** (NEW)
   - 36 integration tests
   - Configuration verification
   - Attack mitigation scenarios
   - Integration with existing security

## Code Changes

### RateLimiter Class
```typescript
export class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private violationCount = 0;

  constructor(maxTokens = 20, refillRate = 5) {
    // Initialize with full bucket
  }

  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) {
      this.violationCount++;
      return false;
    }
    this.tokens -= cost;
    return true;
  }

  // Additional methods: getAvailableTokens(), getViolationCount(), reset()
}
```

### WebSocket Integration
```typescript
// In RemoteConnectorService class
private readonly rateLimiter = new RateLimiter(20, 5);

private async handleMessage(raw: RawData) {
  // ... parse and validate message ...

  // Determine message cost
  let messageCost = 1;
  if (type === "ping" || type === "list-connectors") {
    messageCost = 0.5;
  }

  // Check rate limit BEFORE processing
  if (!this.rateLimiter.tryConsume(messageCost)) {
    console.warn(`[ws-rate-limit] Rate limit exceeded`);
    this.send({
      type: "error",
      requestId,
      error: "Rate limit exceeded. Please slow down your requests.",
      code: "RATE_LIMIT_EXCEEDED",
    });
    return;
  }

  // Process message...
}
```

## Testing

### Test Coverage
- **258 total tests** - All passing ✓
- **31 RateLimiter unit tests**
  - Initialization and configuration
  - Token consumption and refill
  - Burst handling and sustained rate
  - Security properties
  - Attack scenarios (operation spam, ping flood, etc.)
  - Edge cases and performance
- **36 WebSocket rate limiting integration tests**
  - Configuration matching HTTP limits
  - Message type cost verification
  - Attack mitigation scenarios
  - Integration with authentication and token expiry
  - Operational considerations

### Test Results
```
✓ test/core/RateLimiter.test.ts (31 tests)
✓ test/server/websocket-rate-limiting.test.ts (36 tests)
✓ All existing tests continue to pass
```

## Security Impact

### Protections Added
✅ Prevents authenticated attackers from spamming unlimited operations
✅ Closes DoS vulnerability via WebSocket
✅ Prevents bypassing HTTP rate limits through WebSocket
✅ Maintains security parity between HTTP and WebSocket
✅ Observable via logs for security monitoring

### Attack Mitigation
| Attack Type | Before Fix | After Fix |
|-------------|------------|-----------|
| Operation spam | ∞ messages | Max 20 burst + 5/sec sustained |
| Ping flood | ∞ pings | Max 40 burst + 10/sec sustained |
| Mixed message spam | ∞ messages | All messages consume tokens |
| DoS via WebSocket | Vulnerable | Protected |

### Security Properties
- **Defense in depth**: Works alongside authentication, token expiry, and circuit breaker
- **Per-connection**: Each connection has independent rate limit
- **Graceful degradation**: Error messages instead of disconnection
- **Monitoring**: Violation tracking and logging for abuse detection
- **Token bucket**: Allows legitimate bursts while enforcing average rate

## Operational Impact

### Monitoring
- Rate limit violations logged with `[ws-rate-limit]` prefix
- Includes message type and violation count
- Can be used to detect abuse patterns

### Client Experience
- Legitimate clients: No impact (within rate limits)
- Bursty traffic: Supported up to 20 messages
- Rate limited clients: Clear error message with actionable guidance
- Recovery: Automatic as tokens refill over time

### Performance
- **Algorithm complexity**: O(1) per message
- **Memory overhead**: Minimal (few integers per connection)
- **CPU overhead**: Negligible (only arithmetic operations)

## Comparison: HTTP vs WebSocket Rate Limiting

| Aspect | HTTP | WebSocket |
|--------|------|-----------|
| **Algorithm** | Sliding window (express-rate-limit) | Token bucket |
| **Rate** | 300 req/min | 300 msg/min (5/sec) |
| **Burst** | N/A | 20 messages |
| **Scope** | Global | Per connection |
| **Protocol fit** | ✓ Short-lived requests | ✓ Long-lived connections |

Both provide equivalent protection levels appropriate for their protocols.

## Test Plan

### Manual Testing Checklist
- [ ] Establish WebSocket connection successfully
- [ ] Send legitimate traffic (< 5 msg/sec) - should work normally
- [ ] Send burst of 20 messages - should all succeed
- [ ] Send burst of 25 messages - last 5 should be rate limited
- [ ] Wait 1 second - should get 5 more tokens
- [ ] Spam 100 messages rapidly - should see rate limit errors
- [ ] Check logs - should see `[ws-rate-limit]` warnings
- [ ] Verify error response has code `RATE_LIMIT_EXCEEDED`
- [ ] Verify connection stays open (not disconnected)
- [ ] Verify operation succeeds after waiting for token refill

### Automated Testing
All tests automated and passing:
- Token bucket mechanics
- Message cost differentiation
- Attack scenario mitigation
- Integration with existing security
- Edge cases and performance

## Backwards Compatibility

✅ **Fully backwards compatible**
- No breaking changes to API or message format
- Clients within rate limits see no difference
- Only affects clients exceeding rate limits
- Error responses use standard error format

## Documentation

Code is extensively commented with security context:
- RateLimiter class has detailed documentation
- WebSocket integration has inline security comments
- Test files document attack scenarios and protections

## Related Issues

Fixes: **No Rate Limiting on WebSocket (websocket.ts)**

Related security fixes:
- WebSocket token expiry validation
- JTI replay protection
- pagedResultsCookie size limit

## Deployment Notes

- No configuration changes required
- No database migrations needed
- No environment variable changes
- Rate limiter automatically instantiated per WebSocket connection

## Future Enhancements

Potential improvements (not required for this fix):
1. Make rate limit configurable via environment variables
2. Add metrics export for monitoring dashboards
3. Implement dynamic rate limiting based on user tier
4. Add rate limit headers in responses (like HTTP `X-RateLimit-*`)

---

**Security Review**: This fix addresses a critical DoS vulnerability by implementing message-level rate limiting for WebSocket connections, matching the protection level of HTTP endpoints.

**Test Coverage**: 67 new tests added, all 258 tests passing.

**Ready for Review**: All code complete, tested, and documented.
