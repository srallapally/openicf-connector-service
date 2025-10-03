export type Primitive = string | number | boolean | null;
export type Complex = { [k: string]: Primitive | Primitive[] | Complex | Complex[] };
export type AttributeValue = Primitive | Primitive[] | Complex | Complex[];

export interface ConnectorObject {
  objectClass: string;
  uid: string;
  name?: string;
  attributes: Record<string, AttributeValue>;
}

export interface SortKey { field: string; ascending?: boolean | undefined; }

// src/spi/types.ts (and mirror in external pack)
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

  // convenience
  sortBy?: string | undefined;
  sortOrder?: "ASC" | "DESC" | undefined;
  timeoutMs?: number | undefined;
}


export interface SchemaAttribute {
  name: string;
  type: "string" | "integer" | "boolean" | "datetime" | "reference" | "complex";
  description?: string;
  required?: boolean;
  multiValued?: boolean;
  creatable?: boolean;
  updateable?: boolean;
  readable?: boolean;
  returnedByDefault?: boolean;
  subAttributes?: SchemaAttribute[];
}

export interface ObjectClassInfo {
  name: string;
  nativeName?: string;
  idAttribute?: string;
  nameAttribute?: string;
  supports?: Array<"CREATE"|"UPDATE"|"DELETE"|"GET"|"SEARCH"|"SYNC">;
  attributes: SchemaAttribute[];
}

export interface Schema {
  objectClasses: ObjectClassInfo[];
  features?: { paging?: boolean; sorting?: boolean; scriptOnConnector?: boolean; resolveUsername?: boolean; complexAttributes?: boolean; };
}

// Streaming search types (ICF executeQuery analogue)
export type ResultsHandler = (obj: ConnectorObject) => Promise<boolean> | boolean;
export interface SearchResult { pagedResultsCookie?: string | null; remainingPagedResults?: number | null; }

// Sync types
export interface SyncToken { value: string; }

// Individual op interfaces to enable clean intersections (avoids duplicate property errors)
export interface SearchOpList {
  search(objectClass: string, filter: any, options?: OperationOptions): Promise<{ results: ConnectorObject[]; nextOffset?: number }>;
}
export interface SearchOpStreaming {
  search(objectClass: string, filter: any, handler: ResultsHandler, options?: OperationOptions): Promise<SearchResult>;
}
export interface SyncOp {
  sync(objectClass: string, token: SyncToken | null, options?: OperationOptions): Promise<{ token: SyncToken; changes: ConnectorObject[] }>;
}

export type ConnectorSpi = Partial<SearchOpList & SearchOpStreaming & SyncOp & {
  test(): Promise<void>;
  schema(): Promise<Schema>;
  create(objectClass: string, attrs: Record<string, AttributeValue>, options?: OperationOptions): Promise<ConnectorObject>;
  get(objectClass: string, uid: string, options?: OperationOptions): Promise<ConnectorObject | null>;
  update(objectClass: string, uid: string, attrs: Record<string, AttributeValue>, options?: OperationOptions): Promise<ConnectorObject>;
  delete(objectClass: string, uid: string, options?: OperationOptions): Promise<void>;
}>;
