// src/spi/errors.ts

/**
 * Classification of a connector failure.
 *
 * The set is deliberately small and closed. It exists so the dispatcher can
 * decide an outcome without parsing message strings, not to describe every way
 * a target system can misbehave. Anything that does not map cleanly is
 * `UNKNOWN`, which is handled safely.
 *
 * - `ALREADY_EXISTS`     — create refused: the object is already present.
 * - `UNKNOWN_UID`        — the referenced object does not exist on the target.
 * - `CONNECTION_FAILED`  — transport never reached or lost the target.
 * - `INVALID_ATTRIBUTE`  — the target rejected the payload as malformed.
 * - `PERMISSION_DENIED`  — credentials lack rights for this operation.
 * - `RATE_LIMIT_TARGET`  — the target throttled us (its limit, not ours).
 * - `UNKNOWN`            — unclassified.
 */
export type ConnectorErrorCode =
    | "ALREADY_EXISTS"
    | "UNKNOWN_UID"
    | "CONNECTION_FAILED"
    | "INVALID_ATTRIBUTE"
    | "PERMISSION_DENIED"
    | "RATE_LIMIT_TARGET"
    | "UNKNOWN";

/**
 * Codes that are retryable unless the thrower says otherwise.
 *
 * Only the two transport-level codes qualify. Everything else describes a
 * decision the target already made, and repeating the same request reproduces
 * the same decision.
 */
const RETRYABLE_BY_DEFAULT: ReadonlySet<ConnectorErrorCode> = new Set<ConnectorErrorCode>([
  "CONNECTION_FAILED",
  "RATE_LIMIT_TARGET",
]);

/**
 * The single error type connectors throw.
 *
 * Connectors SHOULD throw `ConnectorError` for every failure they can
 * classify. The dispatcher reads {@link ConnectorError.code} to apply the
 * resolution protocol, and two codes carry specific meaning there:
 *
 * - `UNKNOWN_UID` on a delete resolves to SUCCEEDED. The desired end state is
 *   "object absent", and it is absent.
 * - `ALREADY_EXISTS` on a create resolves to FAILED_CONFIRMED. The target
 *   answered definitively; the caller's own retry settles the rare
 *   delete-then-recreate race.
 *
 * Errors that are not a `ConnectorError` — or that carry `UNKNOWN` — are
 * resolved by whether the target answered at all: FAILED_CONFIRMED when the
 * connector returned a failure inside the deadline, INDETERMINATE when the
 * attempt deadline expired first. That distinction is what keeps an
 * unclassified timeout from being retried into a duplicate account.
 *
 * There are intentionally no subclasses. A hierarchy would invite `instanceof`
 * chains at the call sites that the `code` field already replaces, and it
 * would not survive two copies of this package in one process.
 */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;

  /**
   * Whether repeating the identical request could plausibly succeed.
   *
   * Advisory: the dispatcher still gates retries on operation semantics. A
   * retryable error on a non-idempotent delta update is not retried.
   */
  readonly retryable: boolean;

  constructor(
      code: ConnectorErrorCode,
      message: string,
      opts?: { retryable?: boolean | undefined; cause?: unknown },
  ) {
    // `cause` is passed through the ErrorOptions channel so the original stack
    // survives; connectors routinely wrap a driver error.
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "ConnectorError";
    this.code = code;
    this.retryable = opts?.retryable ?? RETRYABLE_BY_DEFAULT.has(code);

    // Without this the prototype is Error.prototype when the class is
    // down-levelled, and `instanceof` silently returns false.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** True if `e` is a {@link ConnectorError}. */
export function isConnectorError(e: unknown): e is ConnectorError {
  return e instanceof ConnectorError;
}
