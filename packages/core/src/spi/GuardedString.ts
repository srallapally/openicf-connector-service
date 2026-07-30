import { inspect } from "node:util";

const REDACTED = "[REDACTED]";

/**
 * Opt-in wrapper that keeps a secret out of accidental output.
 *
 * What this protects against: accidental disclosure. Template
 * interpolation, `String()`, `JSON.stringify`, `util.inspect` and therefore
 * `console.log`, and error messages built by interpolation all yield
 * `[REDACTED]` instead of the secret.
 *
 * What this does NOT do, stated plainly so nobody relies on more than is
 * there:
 *
 * - It cannot zero memory. JavaScript strings are immutable and the garbage
 *   collector decides when the backing storage goes away. `clear()` drops the
 *   reference; it does not scrub anything.
 * - The secret existed as an ordinary string before it was wrapped -- it was
 *   read from a file, an environment variable or a network response -- and
 *   copies may survive in those buffers.
 * - It cannot stop a connector that deliberately calls `reveal()` and logs the
 *   result. That is the point of `reveal()` being the single, greppable way
 *   out.
 *
 * It does not survive serialization: a `structuredClone` or JSON round trip
 * produces a husk with no secret in it. That is a safe failure and is locked
 * in by tests rather than worked around.
 */
export class GuardedString {
  #value: string | null;

  constructor(value: string) {
    this.#value = value;
  }

  /** The only way to read the secret. Every call site is deliberate and greppable. */
  reveal(): string {
    if (this.#value === null) throw new Error("GuardedString has been cleared");
    return this.#value;
  }

  /** Best-effort: drops the reference. Cannot zero the underlying string. */
  clear(): void {
    this.#value = null;
  }

  get cleared(): boolean {
    return this.#value === null;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export function isGuardedString(v: unknown): v is GuardedString {
  return v instanceof GuardedString;
}
