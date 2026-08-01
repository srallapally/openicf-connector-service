// src/config/runtime.ts
//
// Per-instance runtime tuning for connector execution: attempt deadlines,
// concurrency budgets, and optional read caching.
//
// The interactive slice fraction and per-op rate limits moved to the
// provisioning service at CP-5. Both are claim-loop concerns -- they decide
// what to dispatch and when. Nothing the facade does to execute a single
// operation consults either.
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
} as const;

// ---------- Input shapes (what an operator writes) ----------

export type PerOp<T> = { [K in OpKind]?: T | undefined };

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
  /** Opt-in `get` caching. Absent means no caching at all. */
  readCache?: ReadCacheInput | undefined;
}

// ---------- Resolved shape (what the runtime consumes) ----------

export interface ResolvedRuntimeConfig {
  readonly attemptDeadlineMs: Readonly<Record<OpKind, number>>;
  readonly mutationConcurrency: number;
  readonly readConcurrency: number;
  readonly readCache: Readonly<ReadCacheInput> | null;
}

// ---------- Validation helpers ----------

const RUNTIME_KEYS: ReadonlySet<string> = new Set<keyof RuntimeConfigInput>([
  "attemptDeadlineMs",
  "mutationConcurrency",
  "readConcurrency",
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

  return {
    attemptDeadlineMs: parseAttemptDeadlines(source["attemptDeadlineMs"]),
    mutationConcurrency,
    readConcurrency,
    readCache: parseReadCache(source["readCache"]),
  };
}
