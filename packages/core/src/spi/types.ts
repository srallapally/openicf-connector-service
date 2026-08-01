// src/spi/types.ts
import type { ResultsHandler, SearchResult } from "./icf-compat.js";

// ---------- Core value types ----------
export type ISODateString = string;
export type Primitive = string | number | boolean | null;
export type Complex = { [k: string]: Primitive | Primitive[] | Complex | Complex[] };
export type AttributeValue = Primitive | Primitive[] | Complex | Complex[];

// ---------- Connector object ----------
export interface ConnectorObject {
  objectClass: string;
  uid: string;
  name?: string | undefined;
  attributes: Record<string, AttributeValue>;
}

// ---------- Options & helpers (exactOptionalPropertyTypes-friendly) ----------
export interface SortKey {
  field: string;
  ascending?: boolean | undefined;
}

/**
 * Scheduling hint set from caller provenance, never inferred from request
 * shape. "batch" is the default and the safe value: it cannot starve anyone.
 */
export type OperationPriority = "interactive" | "batch";

export interface OperationOptions {
  attributesToGet?: string[] | undefined;
  pageSize?: number | undefined;
  pagedResultsOffset?: number | undefined;
  pagedResultsCookie?: string | null | undefined;
  sortKeys?: SortKey[] | undefined;
  container?: { objectClass: string; uid: string } | null | undefined;
  scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
  totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
  runAsUser?: string | null | undefined;
  runWithPassword?: string | null | undefined;
  requireSerial?: boolean | undefined;
  failOnError?: boolean | undefined;

  // Convenience
  sortBy?: string | undefined;
  sortOrder?: "ASC" | "DESC" | undefined;
  timeoutMs?: number | undefined;

  // Async provisioning contract (checkpoint CP-1/CP-2)

  /**
   * Cooperative cancellation. The framework aborts this signal when the
   * attempt deadline expires. Connectors MUST pass it to their I/O calls
   * (native fetch honors it directly). An attempt that ignores it keeps
   * its lane slot until the target answers.
   */
  abortSignal?: AbortSignal | undefined;

  /**
   * Absolute deadline as epoch milliseconds. Set once at the API edge.
   * Each layer derives its own wait from the remainder; no layer sets an
   * independent timer. Takes precedence over timeoutMs when both are set.
   */
  deadlineEpochMs?: number | undefined;

  /** Scheduling hint. Absent means "batch". */
  priority?: OperationPriority | undefined;
}

/**
 * Terminal outcome of an async mutation, recorded on the operation row.
 *
 * The three failure states carry different retry contracts and MUST NOT
 * be collapsed:
 * - REJECTED_PRE_DISPATCH: never reached the connector (admission cap,
 *   breaker open, invalid config). Blind retry is safe.
 * - FAILED_CONFIRMED: the target confirmed rejection. Retry per error class.
 * - INDETERMINATE: the deadline expired after dispatch. The target may have
 *   applied the change. Resolve by read-back or reconciliation before any
 *   retry.
 */
export type OperationOutcome =
    | "SUCCEEDED"
    | "REJECTED_PRE_DISPATCH"
    | "FAILED_CONFIRMED"
    | "INDETERMINATE";

// ---------- Schema types ----------
export type AttrType =
    | "string" | "integer" | "boolean" | "datetime" | "reference" | "complex";

export interface AttributeInfo {
  name: string;
  type: AttrType;
  description?: string | undefined;

  required?: boolean | undefined;
  multiValued?: boolean | undefined;
  creatable?: boolean | undefined;
  updateable?: boolean | undefined;
  readable?: boolean | undefined;
  returnedByDefault?: boolean | undefined;

  // Complex attribute support (ICF extension)
  subAttributes?: AttributeInfo[] | undefined;
}

export interface ObjectClassInfo {
  name: string;
  nativeName?: string | undefined;
  idAttribute?: string | undefined;
  nameAttribute?: string | undefined;
  supports?: Array<"CREATE" | "UPDATE" | "DELETE" | "GET" | "SEARCH" | "SYNC"> | undefined;
  attributes: AttributeInfo[];
}

export interface Schema {
  objectClasses: ObjectClassInfo[];
  features?: {
    scriptOnConnector?: boolean | undefined;
    resolveUsername?: boolean | undefined;
    paging?: boolean | undefined;
    sorting?: boolean | undefined;
    complexAttributes?: boolean | undefined;
  } | undefined;
}

// ---------- Misc SPI helper types ----------
export interface SyncToken { value: string; }
export interface ScriptContext {
  language: "javascript" | "python";
  script: string;
  params?: Record<string, unknown> | undefined;
}
export interface ConnectorConfig { [k: string]: unknown; }

// ---------- Operation interfaces ----------
export interface CreateOp {
  create(objectClass: string, attrs: Record<string, AttributeValue>, options?: OperationOptions): Promise<ConnectorObject>;
}
export interface UpdateOp {
  update(objectClass: string, uid: string, attrs: Record<string, AttributeValue>, options?: OperationOptions): Promise<ConnectorObject>;
}
export interface DeleteOp {
  delete(objectClass: string, uid: string, options?: OperationOptions): Promise<void>;
}
export interface GetOp {
  get(objectClass: string, uid: string, options?: OperationOptions): Promise<ConnectorObject | null>;
}

/**
 * SearchOp — single signature that supports both list and streaming forms.
 *
 * Which form is in use is declared by {@link SearchCapability.searchStreaming},
 * never inferred from the function's arity. `Function.length` counts only the
 * parameters before the first defaulted or rest parameter, so it misclassifies
 * in both directions: a list-style `search(objectClass, filter, options)`
 * reports 3 and was misread as streaming, while a streaming
 * `search(objectClass, filter, ...args)` reports 2 and was misread as a list.
 * Destructuring alone does not lower the count -- `({a})` is 1, and only a
 * default makes it 0, as in `({a} = {})`.
 *
 * - `searchStreaming === true`  => the 3rd arg is a {@link ResultsHandler} and
 *   the call resolves to a {@link SearchResult}.
 * - otherwise                   => the 3rd arg is {@link OperationOptions} and
 *   the call resolves to an array payload.
 */
export interface SearchOp {
  search(
      objectClass: string,
      filter: any,
      handlerOrOptions?: ResultsHandler | OperationOptions,
      options?: OperationOptions
  ): Promise<{ results: ConnectorObject[]; nextOffset?: number } | SearchResult>;
}

/**
 * Opt-in declaration that `search` uses the streaming form.
 *
 * Connectors that omit it are treated as list-style, so existing list
 * connectors need no change. A streaming connector MUST set this to `true`.
 */
export interface SearchCapability {
  searchStreaming?: boolean | undefined;
}

export interface SchemaOp { schema(): Promise<Schema>; }
export interface TestOp { test(): Promise<void>; }
export interface SyncOp {
  sync(objectClass: string, token: SyncToken | null, options?: OperationOptions): Promise<{ token: SyncToken; changes: ConnectorObject[] }>;
}
export interface ScriptOnConnectorOp {
  scriptOnConnector(ctx: ScriptContext): Promise<unknown>;
}
export interface ResolveUsernameOp {
  resolveUsername(objectClass: string, username: string): Promise<string | null>;
}
export interface ValidateOp {
  validateConfiguration(config: ConnectorConfig): Promise<void>;
}

// ---------- Full SPI surface (ICF + extras) ----------
export type ConnectorSpi =
    Partial<
        CreateOp &
        UpdateOp &
        DeleteOp &
        GetOp &
        SearchOp &
        SearchCapability &
        SchemaOp &
        TestOp &
        SyncOp &
        ScriptOnConnectorOp &
        ResolveUsernameOp &
        ValidateOp &
        // Optional advanced ops from icf-compat (imported by path with .js)
        import("./icf-compat.js").ConnectorLifecycle &
        import("./icf-compat.js").AuthenticateOp &
        import("./icf-compat.js").BatchOp &
        import("./icf-compat.js").UpdateAttributeValuesOp &
        import("./icf-compat.js").ScriptOnResourceOp &
        import("./icf-compat.js").ConnectorEventSubscriptionOp &
        import("./icf-compat.js").SyncEventSubscriptionOp
    >;