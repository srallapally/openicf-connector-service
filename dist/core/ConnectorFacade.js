import { CircuitBreaker } from "./CircuitBreaker.js";
import { makeCache } from "./Cache.js";
const cache = makeCache();
const key = (parts) => parts.map(p => JSON.stringify(p)).join("|");
export class ConnectorFacade {
    impl;
    breaker;
    constructor(impl, breaker = new CircuitBreaker()) {
        this.impl = impl;
        this.breaker = breaker;
    }
    call(p) { return this.breaker.exec(() => p); }
    async test() { if (this.impl.test)
        await this.call(this.impl.test()); }
    async schema() {
        const k = key(["schema", this.impl.id ?? "anon"]);
        if (cache.has(k))
            return cache.get(k);
        const s = await this.call(this.impl.schema ? this.impl.schema() : Promise.resolve({ objectClasses: [], features: { complexAttributes: true } }));
        cache.set(k, s, { ttl: 5 * 60_000 });
        return s;
    }
    async create(objectClass, attrs, options) {
        if (!this.impl.create)
            throw new Error("Create not supported");
        const res = await this.call(this.impl.create(objectClass, attrs, options));
        cache.delete(key(["schema", this.impl.id ?? "anon"]));
        return res;
    }
    async get(objectClass, uid, options) {
        if (!this.impl.get)
            throw new Error("Get not supported");
        const k = key(["get", this.impl.id ?? "anon", objectClass, uid, options?.attributesToGet?.slice().sort() || []]);
        if (cache.has(k))
            return cache.get(k);
        const obj = await this.call(this.impl.get(objectClass, uid, options));
        if (obj)
            cache.set(k, obj, { ttl: 30_000 });
        return obj;
    }
    async update(objectClass, uid, attrs, options) {
        if (!this.impl.update)
            throw new Error("Update not supported");
        const res = await this.call(this.impl.update(objectClass, uid, attrs, options));
        cache.delete(key(["get", this.impl.id ?? "anon", objectClass, uid]));
        return res;
    }
    async delete(objectClass, uid, options) {
        if (!this.impl.delete)
            throw new Error("Delete not supported");
        const r = await this.call(this.impl.delete(objectClass, uid, options));
        cache.delete(key(["get", this.impl.id ?? "anon", objectClass, uid]));
        return r;
    }
    async addAttributeValues(objectClass, uid, add, options) {
        if (!this.impl.addAttributeValues)
            throw new Error("UpdateAttributeValuesOp not supported");
        return this.call(this.impl.addAttributeValues(objectClass, uid, add, options));
    }
    async removeAttributeValues(objectClass, uid, remove, options) {
        if (!this.impl.removeAttributeValues)
            throw new Error("UpdateAttributeValuesOp not supported");
        return this.call(this.impl.removeAttributeValues(objectClass, uid, remove, options));
    }
    async search(objectClass, filter, options) {
        if (typeof this.impl.search === "function" && this.impl.search.length >= 3) {
            const out = [];
            const handler = (obj) => { out.push(obj); return true; };
            const sr = await this.call(this.impl.search(objectClass, filter, handler, options));
            return { results: out, searchResult: sr };
        }
        if (!this.impl.search)
            throw new Error("Search not supported");
        return this.call(this.impl.search(objectClass, filter, options));
    }
    async sync(objectClass, token, options) {
        if (!this.impl.sync)
            throw new Error("Sync not supported");
        return this.call(this.impl.sync(objectClass, token, options));
    }
    async scriptOnConnector(ctx) {
        if (!this.impl.scriptOnConnector)
            throw new Error("ScriptOnConnector not supported");
        return this.call(this.impl.scriptOnConnector(ctx));
    }
}
