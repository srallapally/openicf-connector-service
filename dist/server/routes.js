// src/server/routes.ts
import { Router } from "express";
import { z } from "zod";
const OBJECT_CLASS_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export function buildRouter(registry) {
    const r = Router();
    // -------- Zod Schemas --------
    const OptionsSchema = z.object({
        attributesToGet: z.array(z.string()).optional(),
        pageSize: z.number().int().positive().max(200).optional(),
        pagedResultsOffset: z.number().int().min(0).optional(),
        pagedResultsCookie: z.string().nullable().optional(),
        sortKeys: z.array(z.object({ field: z.string(), ascending: z.boolean().optional() })).optional(),
        container: z.object({ uid: z.string() }).optional(),
        timeoutMs: z.number().int().positive().optional(),
        allowPartialResults: z.boolean().optional(),
        continueOnError: z.boolean().optional()
    }).partial().strict();
    const SearchBody = z.object({
        objectClass: z.string().optional(),
        filter: z.any().nullable().optional(),
        options: OptionsSchema.optional()
    });
    const SyncBody = z.object({
        objectClass: z.string().optional(),
        token: z.any().nullable().optional(),
        options: OptionsSchema.optional()
    });
    const CreateBody = z.object({
        attrs: z.record(z.any()),
        options: OptionsSchema.optional()
    });
    const UpdateBody = z.object({
        attrs: z.record(z.any()),
        options: OptionsSchema.optional()
    });
    const AttrValuesBody = z.object({
        attrs: z.record(z.any()),
        options: OptionsSchema.optional()
    });
    // -------- Helpers --------
    const jsonErr = (res, code, msg) => res.status(code).json({ error: msg });
    function sanitizeOptions(o) {
        if (!o || typeof o !== "object")
            return undefined;
        const out = {};
        for (const [k, v] of Object.entries(o)) {
            if (v !== undefined)
                out[k] = v;
        }
        return out;
    }
    function getSpi(id) {
        // Prefer has() if available to avoid try/catch
        if (typeof registry.has === "function" && !registry.has(id))
            return undefined;
        // try { return (registry as any).get(id); } catch { return undefined; }
        try {
            const instance = registry.get(id);
            return instance?.impl; // ← Return the impl, not the whole instance
        }
        catch {
            return undefined;
        }
    }
    // Validate objectClass centrally (no inline regex in path)
    r.param("objectClass", (req, res, next, value) => {
        // if (!value || value.startsWith("_")) return jsonErr(res, 404, "Unknown path");
        // if (!OBJECT_CLASS_RE.test(value)) return jsonErr(res, 400, "Invalid objectClass");
        if (!value || !OBJECT_CLASS_RE.test(value)) {
            return res.status(400).json({ error: "Invalid objectClass" });
        }
        return next();
    });
    // -------- Introspection --------
    r.get("/connectors", (_req, res) => {
        try {
            if (typeof registry.ids === "function")
                return res.json({ ids: registry.ids() });
            if (typeof registry.keys === "function")
                return res.json({ ids: Array.from(registry.keys()) });
            return res.json({ ids: [] });
        }
        catch {
            return res.json({ ids: [] });
        }
    });
    r.get("/connectors/:id", (req, res) => {
        const spi = getSpi(req.params.id);
        if (!spi)
            return jsonErr(res, 404, "Not found");
        return res.json({ id: req.params.id, loaded: true });
    });
    // -------- Schema & Test --------
    r.get("/connectors/:id/_schema", async (req, res) => {
        console.log(`Checking schemaOps`);
        const spi = getSpi(req.params.id);
        console.log(`routes.ts ${req.params.id}`);
        if (!spi)
            return jsonErr(res, 404, "Connector not found");
        if (!spi.schema)
            return jsonErr(res, 501, "Schema not implemented");
        try {
            return res.json(await spi.schema());
        }
        catch (e) {
            return jsonErr(res, 500, e?.message || "Schema failed");
        }
    });
    r.post("/connectors/:id/_test", async (req, res) => {
        console.log(`TestOp: ${req.params.id}`);
        const spi = getSpi(req.params.id);
        if (!spi)
            return jsonErr(res, 404, "Connector not found");
        if (!spi.test)
            return jsonErr(res, 501, "Test not implemented");
        try {
            await spi.test();
            return res.status(204).end();
        }
        catch (e) {
            return jsonErr(res, 500, e?.message || "Test failed");
        }
    });
    // -------- Search (no inline regex in path) --------
    r.post("/connectors/:id/:objectClass/_search", async (req, res) => {
        const spi = getSpi(req.params.id);
        if (!spi)
            return jsonErr(res, 404, "Connector not found");
        if (!spi.search)
            return jsonErr(res, 501, "Search not implemented");
        const parsed = SearchBody.safeParse(req.body ?? {});
        if (!parsed.success)
            return jsonErr(res, 400, parsed.error.message);
        const { filter = null, options } = parsed.data;
        try {
            const out = await spi.search(req.params.objectClass, filter, sanitizeOptions(options));
            return res.json(out);
        }
        catch (e) {
            return jsonErr(res, 500, e?.message || "Search failed");
        }
    });
    // -------- Sync --------
    r.post("/connectors/:id/:objectClass/_sync", async (req, res) => {
        const spi = getSpi(req.params.id);
        if (!spi)
            return jsonErr(res, 404, "Connector not found");
        if (!spi.sync)
            return jsonErr(res, 501, "Sync not implemented");
        const parsed = SyncBody.safeParse(req.body ?? {});
        if (!parsed.success)
            return jsonErr(res, 400, parsed.error.message);
        const { token = null, options } = parsed.data;
        try {
            const out = await spi.sync(req.params.objectClass, token, sanitizeOptions(options));
            return res.json(out);
        }
        catch (e) {
            return jsonErr(res, 500, e?.message || "Sync failed");
        }
    });
    // -------- Create --------
    r.post("/connectors/:id/:objectClass", async (req, res) => {
        const spi = getSpi(req.params.id);
        if (!spi)
            return jsonErr(res, 404, "Connector not found");
        if (!spi.create)
            return jsonErr(res, 501, "Create not implemented");
        const parsed = CreateBody.safeParse(req.body ?? {});
        if (!parsed.success)
            return jsonErr(res, 400, parsed.error.message);
        const { attrs, options } = parsed.data;
        try {
            const out = await spi.create(req.params.objectClass, attrs, sanitizeOptions(options));
            return res.status(201).json(out);
        }
        catch (e) {
            return jsonErr(res, 500, e?.message || "Create failed");
        }
    });
    // -------- Get --------
    r.get("/connectors/:id/:objectClass/:uid", async (req, res) => {
        const spi = getSpi(req.params.id);
        if (!spi)
            return jsonErr(res, 404, "Connector not found");
        if (!spi.get)
            return jsonErr(res, 501, "Get not implemented");
        try {
            const out = await spi.get(req.params.objectClass, req.params.uid, sanitizeOptions(req.query));
            return res.json(out);
        }
        catch (e) {
            return jsonErr(res, 404, e?.message || "Not found");
        }
    });
    // -------- Update --------
    r.patch("/connectors/:id/:objectClass/:uid", async (req, res) => {
        const spi = getSpi(req.params.id);
        if (!spi)
            return jsonErr(res, 404, "Connector not found");
        if (!spi.update)
            return jsonErr(res, 501, "Update not implemented");
        const parsed = UpdateBody.safeParse(req.body ?? {});
        if (!parsed.success)
            return jsonErr(res, 400, parsed.error.message);
        const { attrs, options } = parsed.data;
        try {
            const out = await spi.update(req.params.objectClass, req.params.uid, attrs, sanitizeOptions(options));
            return res.json(out);
        }
        catch (e) {
            return jsonErr(res, 500, e?.message || "Update failed");
        }
    });
    // -------- Delete --------
    r.delete("/connectors/:id/:objectClass/:uid", async (req, res) => {
        const spi = getSpi(req.params.id);
        if (!spi)
            return jsonErr(res, 404, "Connector not found");
        if (!spi.delete)
            return jsonErr(res, 501, "Delete not implemented");
        try {
            await spi.delete(req.params.objectClass, req.params.uid, sanitizeOptions(req.query));
            return res.status(204).end();
        }
        catch (e) {
            return jsonErr(res, 500, e?.message || "Delete failed");
        }
    });
    // -------- UpdateAttributeValuesOp --------
    r.post("/connectors/:id/:objectClass/:uid/_addAttributeValues", async (req, res) => {
        const spi = getSpi(req.params.id);
        if (!spi)
            return jsonErr(res, 404, "Connector not found");
        if (!spi.addAttributeValues)
            return jsonErr(res, 501, "UpdateAttributeValuesOp not implemented");
        const parsed = AttrValuesBody.safeParse(req.body ?? {});
        if (!parsed.success)
            return jsonErr(res, 400, parsed.error.message);
        const { attrs, options } = parsed.data;
        try {
            const out = await spi.addAttributeValues(req.params.objectClass, req.params.uid, attrs, sanitizeOptions(options));
            return res.json(out);
        }
        catch (e) {
            return jsonErr(res, 500, e?.message || "addAttributeValues failed");
        }
    });
    r.post("/connectors/:id/:objectClass/:uid/_removeAttributeValues", async (req, res) => {
        const spi = getSpi(req.params.id);
        if (!spi)
            return jsonErr(res, 404, "Connector not found");
        if (!spi.removeAttributeValues)
            return jsonErr(res, 501, "UpdateAttributeValuesOp not implemented");
        const parsed = AttrValuesBody.safeParse(req.body ?? {});
        if (!parsed.success)
            return jsonErr(res, 400, parsed.error.message);
        const { attrs, options } = parsed.data;
        try {
            const out = await spi.removeAttributeValues(req.params.objectClass, req.params.uid, attrs, sanitizeOptions(options));
            return res.json(out);
        }
        catch (e) {
            return jsonErr(res, 500, e?.message || "removeAttributeValues failed");
        }
    });
    // src/server/routes.ts additions
    // Get all connector types and their versions
    r.get("/connectors/_types", (_req, res) => {
        const types = new Map();
        for (const inst of registry.list()) {
            const { type, version } = inst.connectorKey;
            if (!types.has(type)) {
                types.set(type, []);
            }
            types.get(type).push(version);
        }
        const result = Array.from(types.entries()).map(([type, versions]) => ({
            type,
            versions: [...new Set(versions)].sort()
        }));
        return res.json({ types: result });
    });
    // Get metadata about a specific instance including its version
    r.get("/connectors/:id", (req, res) => {
        try {
            const inst = registry.get(req.params.id);
            return res.json({
                id: inst.id,
                type: inst.connectorKey.type,
                version: inst.connectorKey.version,
                loaded: true
            });
        }
        catch {
            return jsonErr(res, 404, "Not found");
        }
    });
    return r;
}
export default buildRouter;
