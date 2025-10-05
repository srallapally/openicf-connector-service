import type { OperationOptions } from "../spi/types.js";
import { CircuitBreaker } from "./CircuitBreaker.js";
import { makeCache } from "./Cache.js";
import type { ResultsHandler, SearchResult } from "../spi/icf-compat.js";

const cache = makeCache();
const key = (parts: any[]) => parts.map(p => JSON.stringify(p)).join("|");

export class ConnectorFacade {
  constructor(private impl: any, private breaker = new CircuitBreaker()) {}

  private invalidateCache(parts: any[]) {
      const prefix = key(parts);
      for (const entryKey of cache.keys()) {
          if (entryKey.startsWith(prefix)) cache.delete(entryKey);
      }
  }

  private call<T>(fn: () => Promise<T>): Promise<T> {
      return this.breaker.exec(fn);
  }

  async test(): Promise<void> {
      if (this.impl.test) await this.call(() => this.impl.test());
  }

  async schema() {
        const k = key(["schema", this.impl.id ?? "anon"]);
        if (cache.has(k)) return cache.get(k);
        const s = await this.call(() =>
            this.impl.schema
                ? this.impl.schema()
                : Promise.resolve({ objectClasses: [], features: { complexAttributes: true } })
        );
        cache.set(k, s, { ttl: 5 * 60_000 });
        return s;
  }

    async create(objectClass: string, attrs: Record<string, any>, options?: OperationOptions) {
        if (!this.impl.create) throw new Error("Create not supported");
        const res = await this.call(() => this.impl.create(objectClass, attrs, options));
        const connectorId = this.impl.id ?? "anon";
        this.invalidateCache(["schema", connectorId]);
        this.invalidateCache(["get", connectorId, objectClass]);
        return res;
    }

    async get(objectClass: string, uid: string, options?: OperationOptions) {
        if (!this.impl.get) throw new Error("Get not supported");
        const k = key(["get", this.impl.id ?? "anon", objectClass, uid, options?.attributesToGet?.slice().sort() || []]);
        if (cache.has(k)) return cache.get(k);
        const obj = await this.call(() => this.impl.get(objectClass, uid, options));
        if (obj) cache.set(k, obj, { ttl: 30_000 });
        return obj;
    }

    async update(objectClass: string, uid: string, attrs: Record<string, any>, options?: OperationOptions) {
        if (!this.impl.update) throw new Error("Update not supported");
        const res = await this.call(() => this.impl.update(objectClass, uid, attrs, options));
        const connectorId = this.impl.id ?? "anon";
        this.invalidateCache(["get", connectorId, objectClass, uid]);
        return res;
    }

    async delete(objectClass: string, uid: string, options?: OperationOptions) {
        if (!this.impl.delete) throw new Error("Delete not supported");
        const r = await this.call(() => this.impl.delete(objectClass, uid, options));
        const connectorId = this.impl.id ?? "anon";
        this.invalidateCache(["get", connectorId, objectClass, uid]);
        return r;
    }

    async addAttributeValues(objectClass: string, uid: string, add: Record<string, any>, options?: OperationOptions) {
        if (!this.impl.addAttributeValues) throw new Error("UpdateAttributeValuesOp not supported");
        return this.call(() => this.impl.addAttributeValues(objectClass, uid, add, options));
    }

    async removeAttributeValues(objectClass: string, uid: string, remove: Record<string, any>, options?: OperationOptions) {
        if (!this.impl.removeAttributeValues) throw new Error("UpdateAttributeValuesOp not supported");
        return this.call(() => this.impl.removeAttributeValues(objectClass, uid, remove, options));
    }

    async search(objectClass: string, filter: any, options?: OperationOptions) {
        if (typeof this.impl.search === "function" && this.impl.search.length >= 3) {
            const out: any[] = [];
            const handler: ResultsHandler = (obj) => { out.push(obj); return true; };
            const sr: SearchResult = await this.call(() =>
                (this.impl as any).search(objectClass, filter, handler, options)
            );
            return { results: out, searchResult: sr };
        }
        if (!this.impl.search) throw new Error("Search not supported");
        return this.call(() => this.impl.search(objectClass, filter, options));
    }

    async sync(objectClass: string, token: any, options?: OperationOptions) {
        if (!this.impl.sync) throw new Error("Sync not supported");
        return this.call(() => this.impl.sync(objectClass, token, options));
    }

    async scriptOnConnector(ctx: { language: string; script: string; params?: Record<string, unknown>; }) {
        if (!this.impl.scriptOnConnector) throw new Error("ScriptOnConnector not supported");
        return this.call(() => this.impl.scriptOnConnector(ctx));
    }
}
