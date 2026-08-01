import type { OperationOptions } from "../spi/types.js";
import { CircuitBreaker } from "../infra/CircuitBreaker.js";
import { makeCache, type Cache } from "../infra/Cache.js";
import type { ResultsHandler, SearchResult } from "../spi/icf-compat.js";
import type { OpKind, ResolvedRuntimeConfig } from "../config/runtime.js";
import { resolveRuntimeConfig, ATTEMPT_DEADLINE_MAX_MS } from "../config/runtime.js";

const key = (parts: any[]) => parts.map(p => JSON.stringify(p)).join("|");

/** How long a schema stays cached. Static per connector version, so this is generous. */
const SCHEMA_TTL_MS = 5 * 60_000;

/**
 * The attempt deadline expired before the connector answered.
 *
 * Distinct from any {@link ConnectorError} on purpose. Every connector error
 * says something about what the target decided; this one says the target
 * decided nothing we know of. For a mutation that is the INDETERMINATE case,
 * and the dispatcher maps it there -- a create that times out may well have
 * been applied, which is why it gets a read-back rather than a retry.
 */
export class DeadlineExpiredError extends Error {
  readonly op: OpKind;
  readonly deadlineEpochMs: number;
  readonly waitedMs: number;

  constructor(op: OpKind, deadlineEpochMs: number, waitedMs: number) {
    super(`${op} exceeded its attempt deadline after ${waitedMs}ms`);
    this.name = "DeadlineExpiredError";
    this.op = op;
    this.deadlineEpochMs = deadlineEpochMs;
    this.waitedMs = waitedMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isDeadlineExpired(e: unknown): e is DeadlineExpiredError {
  return e instanceof DeadlineExpiredError;
}

export interface ConnectorFacadeOptions {
  /** Per-instance tuning. Defaults are applied when omitted. */
  runtime?: ResolvedRuntimeConfig | undefined;
  /** Clock seam for tests. */
  now?: (() => number) | undefined;
}

/**
 * The only layer callers should touch.
 *
 * Wraps a connector SPI with a circuit breaker per plane, an attempt deadline,
 * and -- only when configured -- a small read cache.
 */
export class ConnectorFacade {
  private readonly runtime: ResolvedRuntimeConfig;
  private readonly now: () => number;

  /**
   * Opt-in `get` cache. Null unless `runtime.readCache` is configured.
   *
   * Caching reads is off by default because the previous default was a net
   * loss: a measured 2.45ms invalidation scan on every write, ~315KB per
   * facade before a single entry existed, and cross-replica stale
   * read-after-write. A deployment that knows its read pattern can turn it on.
   */
  private readonly cache: Cache | null;

  /** Schema is static per connector version, so it is cached regardless. */
  private readonly schemaCache = makeCache({ max: 4, ttl: SCHEMA_TTL_MS });

  /**
   * Separate breakers per plane.
   *
   * Sharing one would let a slow streaming search consume the concurrency a
   * mutation needs, invisibly, since both would draw on the same counter.
   */
  private readonly mutationBreaker: CircuitBreaker;
  private readonly readBreaker: CircuitBreaker;

  constructor(
      private impl: any,
      private connectorId: string = "anon",
      opts: ConnectorFacadeOptions = {},
  ) {
    this.runtime = opts.runtime ?? resolveRuntimeConfig();
    this.now = opts.now ?? (() => Date.now());

    const readCache = this.runtime.readCache;
    this.cache = readCache ? makeCache({ max: readCache.max, ttl: readCache.ttlMs }) : null;

    this.mutationBreaker = new CircuitBreaker({
      failureThreshold: 5,
      successThreshold: 2,
      halfOpenAfterMs: 10_000,
      maxConcurrent: this.runtime.mutationConcurrency,
      // A backstop above any per-attempt deadline: the facade's own deadline
      // is the real control, and this only catches a call that escapes it.
      timeoutMs: ATTEMPT_DEADLINE_MAX_MS,
    });

    this.readBreaker = new CircuitBreaker({
      failureThreshold: 5,
      successThreshold: 2,
      halfOpenAfterMs: 10_000,
      maxConcurrent: this.runtime.readConcurrency,
      timeoutMs: ATTEMPT_DEADLINE_MAX_MS,
    });
  }

  /**
   * Run one attempt under a breaker, a deadline, and a linked abort signal.
   *
   * The deadline is the smaller of this operation's configured attempt budget
   * and whatever remains of the caller's end-to-end budget. Deriving rather
   * than restarting is the point: each layer takes its wait from one budget
   * set at the API edge, so nesting cannot multiply the total.
   */
  private async guarded<T>(
      op: OpKind,
      options: OperationOptions | undefined,
      invoke: (derived: OperationOptions) => Promise<T>,
  ): Promise<T> {
    const startedAt = this.now();
    const attemptMs = this.runtime.attemptDeadlineMs[op];
    const callerDeadline = options?.deadlineEpochMs;
    const remaining = callerDeadline === undefined ? Infinity : callerDeadline - startedAt;
    const timeoutMs = Math.min(remaining, attemptMs);
    const deadlineEpochMs = startedAt + timeoutMs;

    // The caller's budget is already spent: dispatching would burn a slot on
    // work whose answer nobody is still waiting for.
    if (timeoutMs <= 0) {
      throw new DeadlineExpiredError(op, callerDeadline ?? deadlineEpochMs, 0);
    }

    const controller = new AbortController();
    const callerSignal = options?.abortSignal;
    let timedOut = false;

    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new DeadlineExpiredError(op, deadlineEpochMs, this.now() - startedAt));
      }, timeoutMs);
    });

    const derived: OperationOptions = {
      ...(options ?? {}),
      abortSignal: controller.signal,
      deadlineEpochMs,
    };

    const breaker = this.breakerFor(op);

    try {
      return await breaker.exec(() => Promise.race([invoke(derived), expiry]));
    } catch (e) {
      // Our own timer fired, so whatever the connector threw on the way down
      // -- usually an AbortError caused by us -- is a symptom. The outcome is
      // "we stopped waiting", and only that distinction keeps a timed-out
      // create from being retried into a duplicate account.
      if (timedOut) {
        throw new DeadlineExpiredError(op, deadlineEpochMs, this.now() - startedAt);
      }
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
      // Nothing awaits `expiry` once the race settles; without a catch its
      // rejection would surface as an unhandled rejection.
      expiry.catch(() => { /* already handled or irrelevant */ });
    }
  }

  private breakerFor(op: OpKind): CircuitBreaker {
    return op === "create" || op === "update" || op === "delete"
        ? this.mutationBreaker
        : this.readBreaker;
  }

  async test(): Promise<void> {
    if (this.impl.test) await this.readBreaker.exec(() => this.impl.test());
  }

  async schema() {
    const k = key(["schema", this.connectorId]);
    if (this.schemaCache.has(k)) return this.schemaCache.get(k);
    const s = await this.readBreaker.exec(() =>
        this.impl.schema
            ? this.impl.schema()
            : Promise.resolve({ objectClasses: [], features: { complexAttributes: true } })
    );
    this.schemaCache.set(k, s);
    return s;
  }

  async create(objectClass: string, attrs: Record<string, any>, options?: OperationOptions) {
    if (!this.impl.create) throw new Error("Create not supported");
    return this.guarded("create", options, d => this.impl.create(objectClass, attrs, d));
  }

  async get(objectClass: string, uid: string, options?: OperationOptions) {
    if (!this.impl.get) throw new Error("Get not supported");

    const k = this.cache
        ? key(["get", this.connectorId, objectClass, uid, options?.attributesToGet?.slice().sort() || []])
        : null;

    if (k !== null && this.cache!.has(k)) return this.cache!.get(k);

    const obj = await this.guarded("get", options, d => this.impl.get(objectClass, uid, d));

    // TTL only. There is deliberately no write-through invalidation: the scan
    // it required cost more than the cache saved, and it could not have been
    // correct across replicas anyway.
    if (k !== null && obj) this.cache!.set(k, obj);
    return obj;
  }

  async update(objectClass: string, uid: string, attrs: Record<string, any>, options?: OperationOptions) {
    if (!this.impl.update) throw new Error("Update not supported");
    return this.guarded("update", options, d => this.impl.update(objectClass, uid, attrs, d));
  }

  async delete(objectClass: string, uid: string, options?: OperationOptions) {
    if (!this.impl.delete) throw new Error("Delete not supported");
    return this.guarded("delete", options, d => this.impl.delete(objectClass, uid, d));
  }

  async addAttributeValues(objectClass: string, uid: string, add: Record<string, any>, options?: OperationOptions) {
    if (!this.impl.addAttributeValues) throw new Error("UpdateAttributeValuesOp not supported");
    return this.guarded("update", options, d => this.impl.addAttributeValues(objectClass, uid, add, d));
  }

  async removeAttributeValues(objectClass: string, uid: string, remove: Record<string, any>, options?: OperationOptions) {
    if (!this.impl.removeAttributeValues) throw new Error("UpdateAttributeValuesOp not supported");
    return this.guarded("update", options, d => this.impl.removeAttributeValues(objectClass, uid, remove, d));
  }

  /**
   * Search, in either the streaming or the list form.
   *
   * When the caller supplies a ResultsHandler it is passed straight through to
   * a streaming connector -- nothing is buffered, so backpressure from the
   * handler reaches the connector and results are never materialized. A
   * handler returning false stops production at the source.
   *
   * When the caller supplies no handler it is asking for a list, and a list is
   * what it gets, capped at `pageSize`. Buffering there is the caller's
   * explicit choice rather than the facade silently defeating a streaming
   * connector, which is what the old unconditional buffer did.
   */
  async search(
      objectClass: string,
      filter: any,
      handlerOrOptions?: ResultsHandler | OperationOptions,
      maybeOptions?: OperationOptions,
  ): Promise<any> {
    if (!this.impl.search) throw new Error("Search not supported");

    const callerHandler = typeof handlerOrOptions === "function"
        ? handlerOrOptions as ResultsHandler
        : undefined;
    const options = callerHandler
        ? maybeOptions
        : handlerOrOptions as OperationOptions | undefined;

    const streamingConnector = this.impl.searchStreaming === true;

    if (callerHandler) {
      return this.guarded("search", options, async d => {
        if (streamingConnector) {
          // End to end: the connector writes into the caller's handler.
          return this.impl.search(objectClass, filter, callerHandler, d);
        }
        // A list connector still has to honour the handler's contract,
        // including an early stop.
        const listed = await this.impl.search(objectClass, filter, d);
        for (const obj of listed?.results ?? []) {
          if (callerHandler(obj) === false) break;
        }
        return listed;
      });
    }

    return this.guarded("search", options, async d => {
      if (!streamingConnector) return this.impl.search(objectClass, filter, d);

      const out: any[] = [];
      const limit = options?.pageSize ?? Infinity;
      const handler: ResultsHandler = (obj) => { out.push(obj); return out.length < limit; };
      const sr: SearchResult = await this.impl.search(objectClass, filter, handler, d);
      return { results: out, searchResult: sr };
    });
  }

  async sync(objectClass: string, token: any, options?: OperationOptions) {
    if (!this.impl.sync) throw new Error("Sync not supported");
    return this.guarded("sync", options, d => this.impl.sync(objectClass, token, d));
  }

  async scriptOnConnector(ctx: { language: string; script: string; params?: Record<string, unknown>; }) {
    if (!this.impl.scriptOnConnector) throw new Error("ScriptOnConnector not supported");
    return this.readBreaker.exec(() => this.impl.scriptOnConnector(ctx));
  }
}
