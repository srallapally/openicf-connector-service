// src/config/runtime.ts
//
// Per-instance runtime tuning: attempt deadlines, concurrency budgets, the
// interactive slice, optional target rate limits, and optional read caching.
//
// Validation is hand-rolled rather than schema-driven. The core package has no
// schema library among its dependencies, and the checks here need error
// messages that explain *why* a bound exists -- an operator who wrote -1
// expecting "unlimited" needs to be told that a hung target would hold a lane
// slot, not just that the value failed a range test.

/** Every operation kind that can be tuned independently. */
export const OP_KINDS = ["create", "update", "delete", "get", "search", "sync"] as const;
export type OpKind = (typeof OP_KINDS)[number];

/** Operations that change target state and draw from the mutation budget. */
export const MUTATION_OP_KINDS = ["create", "update", "delete"] as const;
export type MutationOpKind = (typeof MUTATION_OP_KINDS)[number];

/** Operations that only read and draw from the read budget. */
export const READ_OP_KINDS = ["get", "search", "sync"] as const;
export type ReadOpKind = (typeof READ_OP_KINDS)[number];

export function isMutationOp(op: OpKind): op is MutationOpKind {
  return (MUTATION_OP_KINDS as readonly OpKind[]).includes(op);
}

// ---------- Bounds and defaults ----------

/**
 * Deadline floor. One millisecond is meaningless in practice but is the
 * smallest coherent positive value; the point of the floor is to exclude 0 and
 * -1, not to express a sensible minimum.
 */
export const ATTEMPT_DEADLINE_MIN_MS = 1;

/**
 * Deadline ceiling. Two minutes is already far beyond any healthy target; past
 * it, a single stuck attempt holds a lane slot long enough to matter.
 */
export const ATTEMPT_DEADLINE_MAX_MS = 120_000;

export const RUNTIME_DEFAULTS = {
  attemptDeadlineMs: 3_000,
  mutationConcurrency: 10,
  readConcurrency: 10,
  interactiveSliceFraction: 0.2,
} as const;

// ---------- Input shapes (what an operator writes) ----------

export type PerOp<T> = { [K in OpKind]?: T | undefined };

export interface RateLimitInput {
  /** Requests permitted per `requestPeriodMs`. */
  requestLimit: number;
  /** Window length in milliseconds. */
  requestPeriodMs: number;
  /** How long to wait for a token before giving up. Omit to fail fast. */
  requestTimeoutMs?: number | undefined;
}

export interface ReadCacheInput {
  ttlMs: number;
  max: number;
}

/**
 * The optional `runtime` block on an instance definition.
 *
 * Every field is optional; an absent block resolves to the documented
 * defaults. Unknown keys are rejected, because a silently ignored typo in a
 * concurrency budget is indistinguishable from the default until production
 * load makes it obvious.
 */
export interface RuntimeConfigInput {
  /** One value for every op, or a per-op record. Milliseconds. */
  attemptDeadlineMs?: number | PerOp<number> | undefined;
  mutationConcurrency?: number | undefined;
  readConcurrency?: number | undefined;
  interactiveSliceFraction?: number | undefined;
  rateLimits?: PerOp<RateLimitInput> | undefined;
  /** Opt-in `get` caching. Absent means no caching at all. */
  readCache?: ReadCacheInput | undefined;
}

// ---------- Resolved shape (what the runtime consumes) ----------

export interface ResolvedRateLimit {
  requestLimit: number;
  requestPeriodMs: number;
  requestTimeoutMs: number | undefined;
}

export interface ResolvedRuntimeConfig {
  readonly attemptDeadlineMs: Readonly<Record<OpKind, number>>;
  readonly mutationConcurrency: number;
  readonly readConcurrency: number;
  readonly interactiveSliceFraction: number;
  /**
   * Mutation slots reserved for `interactive` work.
   *
   * Interactive operations may use the whole mutation budget; this is the
   * portion that batch work may *not* touch, which is what stops a large
   * reconciliation backlog from starving a helpdesk write.
   */
  readonly interactiveSlots: number;
  /** Mutation slots available to `batch` work: budget minus the slice. */
  readonly batchSlots: number;
  readonly rateLimits: Readonly<Partial<Record<OpKind, ResolvedRateLimit>>>;
  readonly readCache: Readonly<ReadCacheInput> | null;
}

// ---------- Validation helpers ----------

const RUNTIME_KEYS: ReadonlySet<string> = new Set<keyof RuntimeConfigInput>([
  "attemptDeadlineMs",
  "mutationConcurrency",
  "readConcurrency",
  "interactiveSliceFraction",
  "rateLimits",
  "readCache",
]);

function describe(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "object") return Array.isArray(v) ? "an array" : "an object";
  return String(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a number, got ${describe(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${path} must be a whole number, got ${value}`);
  }
  if (value < 1) {
    throw new Error(`${path} must be at least 1, got ${value}`);
  }
  return value;
}

/**
 * Parse one attempt deadline.
 *
 * -1 and 0 are called out by name. Operators arriving from IDM-style configs
 * reasonably expect -1 to mean "no timeout", and the failure mode of honouring
 * it is subtle: the operation never resolves, its lane slot is never returned,
 * and throughput for that instance decays without any error being logged.
 */
function parseAttemptDeadline(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${path} must be a whole number of milliseconds, got ${describe(value)}`);
  }
  if (value <= 0) {
    throw new Error(
        `${path} must be between ${ATTEMPT_DEADLINE_MIN_MS} and ${ATTEMPT_DEADLINE_MAX_MS} ms, got ${value}. ` +
        `Unlimited (-1) is rejected deliberately: a hung target would hold its lane slot ` +
        `until the process restarts. Set an explicit deadline up to the ${ATTEMPT_DEADLINE_MAX_MS} ms ceiling.`,
    );
  }
  if (value > ATTEMPT_DEADLINE_MAX_MS) {
    throw new Error(
        `${path} is ${value} ms, above the ${ATTEMPT_DEADLINE_MAX_MS} ms ceiling. ` +
        `A target that genuinely needs longer should say so in its connector documentation, ` +
        `and the deployment should absorb the latency asynchronously rather than by holding a slot.`,
    );
  }
  return value;
}

function parseAttemptDeadlines(raw: unknown): Record<OpKind, number> {
  const out = {} as Record<OpKind, number>;

  if (raw === undefined) {
    for (const op of OP_KINDS) out[op] = RUNTIME_DEFAULTS.attemptDeadlineMs;
    return out;
  }

  if (typeof raw === "number") {
    const v = parseAttemptDeadline(raw, "runtime.attemptDeadlineMs");
    for (const op of OP_KINDS) out[op] = v;
    return out;
  }

  if (!isPlainObject(raw)) {
    throw new Error(
        `runtime.attemptDeadlineMs must be a number or a per-op object, got ${describe(raw)}`,
    );
  }

  for (const key of Object.keys(raw)) {
    if (!(OP_KINDS as readonly string[]).includes(key)) {
      throw new Error(
          `runtime.attemptDeadlineMs.${key} is not a known operation. ` +
          `Expected one of: ${OP_KINDS.join(", ")}.`,
      );
    }
  }

  for (const op of OP_KINDS) {
    const v = raw[op];
    out[op] = v === undefined
        ? RUNTIME_DEFAULTS.attemptDeadlineMs
        : parseAttemptDeadline(v, `runtime.attemptDeadlineMs.${op}`);
  }
  return out;
}

function parseRateLimits(raw: unknown): Partial<Record<OpKind, ResolvedRateLimit>> {
  const out: Partial<Record<OpKind, ResolvedRateLimit>> = {};
  if (raw === undefined) return out;

  if (!isPlainObject(raw)) {
    throw new Error(`runtime.rateLimits must be a per-op object, got ${describe(raw)}`);
  }

  for (const key of Object.keys(raw)) {
    if (!(OP_KINDS as readonly string[]).includes(key)) {
      throw new Error(
          `runtime.rateLimits.${key} is not a known operation. ` +
          `Expected one of: ${OP_KINDS.join(", ")}.`,
      );
    }
    const op = key as OpKind;
    const entry = raw[op];
    if (entry === undefined) continue;
    if (!isPlainObject(entry)) {
      throw new Error(`runtime.rateLimits.${op} must be an object, got ${describe(entry)}`);
    }

    for (const field of Object.keys(entry)) {
      if (!["requestLimit", "requestPeriodMs", "requestTimeoutMs"].includes(field)) {
        throw new Error(
            `runtime.rateLimits.${op}.${field} is not a recognised setting. ` +
            `Expected requestLimit, requestPeriodMs, or requestTimeoutMs.`,
        );
      }
    }

    const requestTimeoutMs = entry["requestTimeoutMs"];
    out[op] = {
      requestLimit: requirePositiveInteger(entry["requestLimit"], `runtime.rateLimits.${op}.requestLimit`),
      requestPeriodMs: requirePositiveInteger(entry["requestPeriodMs"], `runtime.rateLimits.${op}.requestPeriodMs`),
      requestTimeoutMs: requestTimeoutMs === undefined
          ? undefined
          : requirePositiveInteger(requestTimeoutMs, `runtime.rateLimits.${op}.requestTimeoutMs`),
    };
  }
  return out;
}

function parseReadCache(raw: unknown): ReadCacheInput | null {
  if (raw === undefined) return null;
  if (!isPlainObject(raw)) {
    throw new Error(`runtime.readCache must be an object, got ${describe(raw)}`);
  }
  for (const field of Object.keys(raw)) {
    if (!["ttlMs", "max"].includes(field)) {
      throw new Error(
          `runtime.readCache.${field} is not a recognised setting. Expected ttlMs or max.`,
      );
    }
  }
  return {
    ttlMs: requirePositiveInteger(raw["ttlMs"], "runtime.readCache.ttlMs"),
    max: requirePositiveInteger(raw["max"], "runtime.readCache.max"),
  };
}

function parseSliceFraction(raw: unknown): number {
  if (raw === undefined) return RUNTIME_DEFAULTS.interactiveSliceFraction;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`runtime.interactiveSliceFraction must be a number, got ${describe(raw)}`);
  }
  if (raw < 0 || raw > 1) {
    throw new Error(`runtime.interactiveSliceFraction must be between 0 and 1 inclusive, got ${raw}`);
  }
  return raw;
}

/**
 * Size the reserved interactive slice.
 *
 * `ceil` so a small fraction against a small budget still reserves a whole
 * slot rather than rounding to nothing -- 0.2 of a budget of 3 is 0.6, and
 * flooring it would leave interactive work with no reservation at all on
 * exactly the instances where contention hurts most.
 *
 * At a budget of 1 there is nothing to divide: the single slot stays shared,
 * and interactive work still wins it whenever it is free, because interactive
 * may draw from the whole budget.
 *
 * A fraction of exactly 0 means no reservation. The floor exists to stop a
 * small positive fraction from rounding down to nothing, not to override an
 * operator who asked for zero -- and since `ceil` already returns at least 1
 * for every positive fraction, 0 was the only input the floor ever changed.
 * Accepting a documented, in-range value and then ignoring it is the surprise
 * worth removing (RFE-1, amended at CP-4).
 */
function computeInteractiveSlots(mutationConcurrency: number, fraction: number): number {
  if (mutationConcurrency <= 1) return 0;
  if (fraction <= 0) return 0;
  return Math.min(mutationConcurrency, Math.max(1, Math.ceil(mutationConcurrency * fraction)));
}

// ---------- Entry point ----------

/**
 * Validate an instance `runtime` block and fill in defaults.
 *
 * Pure: no I/O, no clock, no mutation of the input. Throws `Error` with an
 * operator-readable message on the first problem found, so a bad deployment
 * config fails at `initInstance` rather than on the first operation that
 * happens to touch the bad setting.
 */
export function resolveRuntimeConfig(raw?: RuntimeConfigInput | undefined): ResolvedRuntimeConfig {
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainObject(raw)) {
    throw new Error(`runtime must be an object, got ${describe(raw)}`);
  }

  for (const key of Object.keys(raw)) {
    if (!RUNTIME_KEYS.has(key)) {
      throw new Error(
          `runtime.${key} is not a recognised setting. ` +
          `Expected one of: ${Array.from(RUNTIME_KEYS).join(", ")}.`,
      );
    }
  }

  const source = raw as Record<string, unknown>;

  const mutationConcurrency = source["mutationConcurrency"] === undefined
      ? RUNTIME_DEFAULTS.mutationConcurrency
      : requirePositiveInteger(source["mutationConcurrency"], "runtime.mutationConcurrency");

  const readConcurrency = source["readConcurrency"] === undefined
      ? RUNTIME_DEFAULTS.readConcurrency
      : requirePositiveInteger(source["readConcurrency"], "runtime.readConcurrency");

  const interactiveSliceFraction = parseSliceFraction(source["interactiveSliceFraction"]);
  const interactiveSlots = computeInteractiveSlots(mutationConcurrency, interactiveSliceFraction);

  return {
    attemptDeadlineMs: parseAttemptDeadlines(source["attemptDeadlineMs"]),
    mutationConcurrency,
    readConcurrency,
    interactiveSliceFraction,
    interactiveSlots,
    batchSlots: mutationConcurrency - interactiveSlots,
    rateLimits: parseRateLimits(source["rateLimits"]),
    readCache: parseReadCache(source["readCache"]),
  };
}
