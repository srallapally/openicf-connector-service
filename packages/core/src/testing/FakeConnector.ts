// test/harness/FakeConnector.ts
//
// A real ConnectorSpi backed by an in-memory target.
//
// Behaviour emerges from the target's state rather than from per-test stubs:
// creating a name that is already taken throws ALREADY_EXISTS because the name
// is taken, and deleting a missing uid throws UNKNOWN_UID because it is
// missing. That matters for the resolution protocol, where the interesting
// cases are exactly the ones where the target's state and the framework's
// belief about it have diverged.

import { ConnectorError } from "../spi/errors.js";
import type { ConnectorErrorCode } from "../spi/errors.js";
import type {
  AttributeValue,
  ConnectorObject,
  ConnectorSpi,
  OperationOptions,
  Schema,
  SyncToken,
} from "../spi/types.js";
import type { ResultsHandler, SearchResult } from "../spi/icf-compat.js";

export const DEFAULT_NAME_ATTRIBUTE = "__NAME__";
export const DEFAULT_OBJECT_CLASS = "__ACCOUNT__";

/** One recorded SPI invocation. */
export interface CallRecord {
  op: string;
  args: unknown[];
  /** True if the call ended because its abort signal fired. */
  abortHonored: boolean;
}

/**
 * The in-memory target system.
 *
 * Deliberately separate from the SPI object: a pooled connector hands out N
 * distinct SPI instances that must all see one target, which is precisely what
 * the pooling test needs to observe.
 */
export class FakeTarget {
  private seq = 0;
  readonly accounts = new Map<string, Record<string, AttributeValue>>();
  private byName = new Map<string, string>();

  constructor(readonly nameAttribute: string = DEFAULT_NAME_ATTRIBUTE) {}

  get size(): number { return this.accounts.size; }

  mintUid(): string { return `uid-${++this.seq}`; }

  nameOf(attrs: Record<string, AttributeValue>): string | undefined {
    const v = attrs[this.nameAttribute];
    return typeof v === "string" ? v : undefined;
  }

  create(attrs: Record<string, AttributeValue>): string {
    const name = this.nameOf(attrs);
    if (name === undefined) {
      throw new ConnectorError("INVALID_ATTRIBUTE", `missing ${this.nameAttribute}`);
    }
    if (this.byName.has(name)) {
      throw new ConnectorError("ALREADY_EXISTS", `${name} already exists`);
    }
    const uid = this.mintUid();
    this.accounts.set(uid, { ...attrs });
    this.byName.set(name, uid);
    return uid;
  }

  update(uid: string, attrs: Record<string, AttributeValue>): void {
    const existing = this.accounts.get(uid);
    if (!existing) throw new ConnectorError("UNKNOWN_UID", `no such uid ${uid}`);
    // Replace semantics: idempotent by construction, which is why a
    // full-replace update is always safe to retry.
    this.accounts.set(uid, { ...existing, ...attrs });
  }

  /**
   * Append values to a multi-valued attribute.
   *
   * `dedup` is what makes the operation idempotent. With it, applying the same
   * grant twice is indistinguishable from applying it once -- set semantics.
   * Without it, every replay appends again, which is exactly the corruption
   * the manifest's `idempotentDelta` flag exists to gate.
   */
  addValues(uid: string, attrs: Record<string, AttributeValue>, dedup = true): void {
    const existing = this.accounts.get(uid);
    if (!existing) throw new ConnectorError("UNKNOWN_UID", `no such uid ${uid}`);

    for (const [key, value] of Object.entries(attrs)) {
      const incoming = Array.isArray(value) ? value : [value];
      const current = existing[key];
      const currentArr = current === undefined ? [] : (Array.isArray(current) ? current : [current]);
      const merged = [...(currentArr as unknown[]), ...(incoming as unknown[])];
      existing[key] = (dedup ? Array.from(new Set(merged)) : merged) as AttributeValue;
    }
  }

  /** Remove values from a multi-valued attribute. Idempotent by construction. */
  removeValues(uid: string, attrs: Record<string, AttributeValue>): void {
    const existing = this.accounts.get(uid);
    if (!existing) throw new ConnectorError("UNKNOWN_UID", `no such uid ${uid}`);

    for (const [key, value] of Object.entries(attrs)) {
      const doomed = new Set((Array.isArray(value) ? value : [value]) as unknown[]);
      const current = existing[key];
      if (current === undefined) continue;
      const currentArr = (Array.isArray(current) ? current : [current]) as unknown[];
      existing[key] = currentArr.filter(v => !doomed.has(v)) as AttributeValue;
    }
  }

  delete(uid: string): void {
    const existing = this.accounts.get(uid);
    if (!existing) throw new ConnectorError("UNKNOWN_UID", `no such uid ${uid}`);
    const name = this.nameOf(existing);
    if (name !== undefined) this.byName.delete(name);
    this.accounts.delete(uid);
  }

  findByName(name: string): string | undefined {
    return this.byName.get(name);
  }

  toConnectorObject(uid: string, objectClass: string): ConnectorObject | null {
    const attrs = this.accounts.get(uid);
    if (!attrs) return null;
    const name = this.nameOf(attrs);
    return { objectClass, uid, ...(name === undefined ? {} : { name }), attributes: { ...attrs } };
  }
}

/** Fault injection and inspection surface. */
export interface FakeConnectorControls {
  /** Sticky delay applied to every subsequent call. Set 0 to clear. */
  latency(ms: number): void;
  /** Fail the next call with this code. One-shot. */
  failNext(code: ConnectorErrorCode, message?: string): void;
  /** Next call never resolves until its abort signal fires, then rejects. One-shot. */
  hangUntilAborted(): void;
  /**
   * Next call applies its mutation to the target and then never resolves.
   * One-shot.
   *
   * This is the INDETERMINATE case that makes read-back necessary: the target
   * really did the work, and the caller cannot possibly know.
   */
  applyThenHang(): void;
  /** Clear every armed fault and the call log. Target state is untouched. */
  reset(): void;
  readonly calls: CallRecord[];
  readonly target: FakeTarget;
  /** Count of calls for one op. */
  countOf(op: string): number;
}

export interface FakeConnectorOptions {
  target?: FakeTarget;
  nameAttribute?: string;
  objectClass?: string;
  /** Mirrors SearchCapability.searchStreaming. */
  searchStreaming?: boolean;
  /** Mirrors the manifest flag; when false, search rejects equality-by-name lookups. */
  equalitySearchOnName?: boolean;
  /**
   * Make `addAttributeValues` append without deduplicating.
   *
   * Models a target whose delta is list-valued rather than set-valued, where
   * replaying a grant genuinely doubles it. Used to demonstrate what the
   * `idempotentDelta` retry gate prevents.
   */
  nonIdempotentDelta?: boolean;
  /** Omit operations entirely, to exercise "not supported" paths. */
  omit?: Array<"create" | "update" | "delete" | "get" | "search" | "sync" | "test" | "dispose"
      | "addAttributeValues" | "removeAttributeValues">;
}

export type FakeConnector = ConnectorSpi & { readonly controls: FakeConnectorControls };

type Armed =
    | { kind: "none" }
    | { kind: "fail"; code: ConnectorErrorCode; message: string }
    | { kind: "hang" }
    | { kind: "applyThenHang" };

/**
 * Reject when the signal fires; never resolve otherwise.
 *
 * Mirrors how a real transport behaves under `AbortSignal`: native fetch
 * rejects with an AbortError, it does not resolve with a partial answer.
 */
function hangUntilAbort(signal: AbortSignal | undefined, onAbort: () => void): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (!signal) return; // hangs forever; a test that does this has a bug
    const fire = () => {
      onAbort();
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) return fire();
    signal.addEventListener("abort", fire, { once: true });
  });
}

export function makeFakeConnector(opts: FakeConnectorOptions = {}): FakeConnector {
  const nameAttribute = opts.nameAttribute ?? DEFAULT_NAME_ATTRIBUTE;
  const objectClass = opts.objectClass ?? DEFAULT_OBJECT_CLASS;
  const target = opts.target ?? new FakeTarget(nameAttribute);
  const equalitySearchOnName = opts.equalitySearchOnName ?? true;
  const omit = new Set(opts.omit ?? []);

  const calls: CallRecord[] = [];
  let latencyMs = 0;
  let armed: Armed = { kind: "none" };

  const takeArmed = (): Armed => {
    const a = armed;
    armed = { kind: "none" };
    return a;
  };

  const record = (op: string, args: unknown[]): CallRecord => {
    const entry: CallRecord = { op, args, abortHonored: false };
    calls.push(entry);
    return entry;
  };

  /** Apply latency, then whatever fault is armed, then the real behaviour. */
  async function run<T>(
      op: string,
      args: unknown[],
      options: OperationOptions | undefined,
      apply: () => T,
  ): Promise<T> {
    const entry = record(op, args);
    const signal = options?.abortSignal;

    if (latencyMs > 0) {
      await new Promise<void>(res => setTimeout(res, latencyMs));
    }

    const fault = takeArmed();

    if (fault.kind === "fail") {
      throw new ConnectorError(fault.code, fault.message);
    }
    if (fault.kind === "hang") {
      return hangUntilAbort(signal, () => { entry.abortHonored = true; });
    }
    if (fault.kind === "applyThenHang") {
      apply(); // the target really does the work...
      return hangUntilAbort(signal, () => { entry.abortHonored = true; }); // ...and we never learn
    }

    if (signal?.aborted) {
      entry.abortHonored = true;
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }

    return apply();
  }

  const controls: FakeConnectorControls = {
    latency(ms) { latencyMs = ms; },
    failNext(code, message) { armed = { kind: "fail", code, message: message ?? `injected ${code}` }; },
    hangUntilAborted() { armed = { kind: "hang" }; },
    applyThenHang() { armed = { kind: "applyThenHang" }; },
    reset() { armed = { kind: "none" }; latencyMs = 0; calls.length = 0; },
    calls,
    target,
    countOf: (op) => calls.filter(c => c.op === op).length,
  };

  const spi: Record<string, unknown> = { controls };

  if (!omit.has("create")) {
    spi["create"] = (oc: string, attrs: Record<string, AttributeValue>, options?: OperationOptions) =>
        run("create", [oc, attrs], options, () => {
          const uid = target.create(attrs);
          return target.toConnectorObject(uid, oc)!;
        });
  }

  if (!omit.has("update")) {
    spi["update"] = (oc: string, uid: string, attrs: Record<string, AttributeValue>, options?: OperationOptions) =>
        run("update", [oc, uid, attrs], options, () => {
          target.update(uid, attrs);
          return target.toConnectorObject(uid, oc)!;
        });
  }

  if (!omit.has("delete")) {
    spi["delete"] = (oc: string, uid: string, options?: OperationOptions) =>
        run("delete", [oc, uid], options, () => { target.delete(uid); });
  }

  if (!omit.has("addAttributeValues")) {
    spi["addAttributeValues"] = (oc: string, uid: string, add: Record<string, AttributeValue>, options?: OperationOptions) =>
        run("addAttributeValues", [oc, uid, add], options, () => {
          target.addValues(uid, add, opts.nonIdempotentDelta !== true);
          return target.toConnectorObject(uid, oc)!;
        });
  }

  if (!omit.has("removeAttributeValues")) {
    spi["removeAttributeValues"] = (oc: string, uid: string, remove: Record<string, AttributeValue>, options?: OperationOptions) =>
        run("removeAttributeValues", [oc, uid, remove], options, () => {
          target.removeValues(uid, remove);
          return target.toConnectorObject(uid, oc)!;
        });
  }

  if (!omit.has("get")) {
    spi["get"] = (oc: string, uid: string, options?: OperationOptions) =>
        run("get", [oc, uid], options, () => target.toConnectorObject(uid, oc));
  }

  if (!omit.has("search")) {
    spi["searchStreaming"] = opts.searchStreaming === true;

    spi["search"] = (
        oc: string,
        filter: any,
        handlerOrOptions?: ResultsHandler | OperationOptions,
        maybeOptions?: OperationOptions,
    ) => {
      const streaming = opts.searchStreaming === true;
      const handler = streaming ? (handlerOrOptions as ResultsHandler) : undefined;
      const options = streaming ? maybeOptions : (handlerOrOptions as OperationOptions | undefined);

      return run("search", [oc, filter], options, () => {
        const matches = matchAll(target, filter, oc, equalitySearchOnName);

        if (streaming) {
          for (const obj of matches) {
            // A handler returning false is the caller saying "stop"; a
            // connector that keeps producing after that is the bug this
            // exists to catch.
            if (handler!(obj) === false) break;
          }
          const sr: SearchResult = { pagedResultsCookie: null, remainingPagedResults: -1 } as SearchResult;
          return sr;
        }
        return { results: matches };
      });
    };
  }

  if (!omit.has("sync")) {
    spi["sync"] = (oc: string, token: SyncToken | null, options?: OperationOptions) =>
        run("sync", [oc, token], options, () => ({
          token: { value: String(target.size) },
          changes: Array.from(target.accounts.keys()).map(uid => target.toConnectorObject(uid, oc)!),
        }));
  }

  if (!omit.has("test")) {
    spi["test"] = () => run("test", [], undefined, () => { /* healthy */ });
  }

  if (!omit.has("dispose")) {
    spi["dispose"] = async () => { record("dispose", []); };
  }

  spi["schema"] = async (): Promise<Schema> => ({
    objectClasses: [{
      name: objectClass,
      idAttribute: "__UID__",
      nameAttribute,
      supports: ["CREATE", "UPDATE", "DELETE", "GET", "SEARCH", "SYNC"],
      attributes: [{ name: nameAttribute, type: "string", required: true }],
    }],
  });

  return spi as unknown as FakeConnector;
}

/**
 * Minimal filter evaluation: enough for the create read-back, which is the
 * only filter shape the dispatcher constructs.
 *
 * Understands the framework's canonical CMP node (`{ type: "CMP", op: "EQ",
 * path, value }`) and a loose `{ attribute, value }` form, so a test can write
 * either.
 */
function matchAll(
    target: FakeTarget,
    filter: any,
    objectClass: string,
    equalitySearchOnName: boolean,
): ConnectorObject[] {
  const all = Array.from(target.accounts.keys())
      .map(uid => target.toConnectorObject(uid, objectClass)!);

  if (!filter) return all;

  const attr: string | undefined = filter.type === "CMP"
      ? filter.path?.[0]
      : filter.attribute ?? filter.field ?? filter.name;
  const value = filter.value;

  if (attr === undefined) return all;

  if (attr === target.nameAttribute && !equalitySearchOnName) {
    throw new ConnectorError(
        "INVALID_ATTRIBUTE",
        `equality search on ${target.nameAttribute} is not supported by this connector`,
    );
  }

  return all.filter(o => o.attributes[attr] === value);
}
