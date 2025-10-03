import type { ConnectorObject } from "./types.js";

export type Uid = string;

export type ResultsHandler = (obj: ConnectorObject) => Promise<boolean> | boolean;

export interface SearchResult {
  pagedResultsCookie?: string | null;
  remainingPagedResults?: number | null; // -1 => unknown
}

export interface Subscription {
  close(): Promise<void>;
}

export interface ConnectorLifecycle {
  init?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface PoolableConnector extends ConnectorLifecycle {}

export interface AuthenticateOp {
  authenticate(objectClass: string, username: string, password: string, options?: import("./types.js").OperationOptions): Promise<Uid>;
}

export interface BatchOp {
  batch(ops: Array<{ op: string; params: any }>, options?: import("./types.js").OperationOptions): Promise<{ results: any[] }>;
}

export interface UpdateAttributeValuesOp {
  addAttributeValues(objectClass: string, uid: Uid, add: Record<string, import("./types.js").AttributeValue>, options?: import("./types.js").OperationOptions): Promise<import("./types.js").ConnectorObject>;
  removeAttributeValues(objectClass: string, uid: Uid, remove: Record<string, import("./types.js").AttributeValue>, options?: import("./types.js").OperationOptions): Promise<import("./types.js").ConnectorObject>;
}

export interface ScriptOnResourceOp {
  scriptOnResource(ctx: import("./types.js").ScriptContext, options?: import("./types.js").OperationOptions): Promise<unknown>;
}

export interface ConnectorEventSubscriptionOp {
  subscribe(objectClass: string, handler: ResultsHandler, options?: import("./types.js").OperationOptions): Promise<Subscription>;
}
export interface SyncEventSubscriptionOp {
  subscribeSync(objectClass: string, handler: (delta: any) => Promise<boolean> | boolean, options?: import("./types.js").OperationOptions): Promise<Subscription>;
}
