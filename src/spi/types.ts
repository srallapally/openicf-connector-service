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
}

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
 * SearchOp — single signature that supports both list and streaming forms:
 * - If the 3rd arg is a function => streaming (ResultsHandler) and resolves to SearchResult
 * - Otherwise => options and resolves to an array payload
 */
export interface SearchOp {
  search(
      objectClass: string,
      filter: any,
      handlerOrOptions?: ResultsHandler | OperationOptions,
      options?: OperationOptions
  ): Promise<{ results: ConnectorObject[]; nextOffset?: number } | SearchResult>;
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
        SchemaOp &
        TestOp &
        SyncOp &
        ScriptOnConnectorOp &
        ResolveUsernameOp &
        ValidateOp &
        // Optional advanced ops from icf-compat (imported by path with .js)
        import("./icf-compat.js").AuthenticateOp &
        import("./icf-compat.js").BatchOp &
        import("./icf-compat.js").UpdateAttributeValuesOp &
        import("./icf-compat.js").ScriptOnResourceOp &
        import("./icf-compat.js").ConnectorEventSubscriptionOp &
        import("./icf-compat.js").SyncEventSubscriptionOp
    >;
