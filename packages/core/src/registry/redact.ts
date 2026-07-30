import { isGuardedString } from "../spi/GuardedString.js";

const MASK = "***";

/**
 * Keys whose values are masked in listings.
 *
 * This deliberately over-matches. `tokenUrl` and `publicKeyPath` are not
 * secrets but contain "token" and "key", so they come back as "***" too. For a
 * listing API that is the right direction to err: a masked endpoint URL is a
 * minor inconvenience, a leaked client secret is not. Callers that need the
 * real values use `get()`, which is unredacted.
 */
const SECRET_KEY = /pass|secret|token|key/i;

/**
 * Deep copy of `value` with secret-looking entries replaced by "***".
 *
 * A key matching {@link SECRET_KEY} is masked regardless of its value, and any
 * GuardedString is masked regardless of its key -- so a secret parked under an
 * innocuous name like `credential` is still covered.
 */
export function redactSecrets<T>(value: T): T {
    return walk(value) as T;
}

function walk(value: unknown): unknown {
    if (isGuardedString(value)) return MASK;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = SECRET_KEY.test(k) ? MASK : walk(v);
        }
        return out;
    }
    return value;
}
