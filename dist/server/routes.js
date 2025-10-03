import { Router } from "express";
import { z } from "zod";
// ---- Schemas ----
const OptionsSchema = z.object({
    attributesToGet: z.array(z.string()).optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    pagedResultsOffset: z.number().int().min(0).optional(),
    pagedResultsCookie: z.string().nullable().optional(),
    sortKeys: z.array(z.object({
        field: z.string(),
        ascending: z.boolean().optional()
    })).optional(),
    container: z.object({ objectClass: z.string(), uid: z.string() }).nullable().optional(),
    scope: z.enum(["OBJECT", "ONE_LEVEL", "SUBTREE"]).optional(),
    totalPagedResultsPolicy: z.enum(["NONE", "ESTIMATE", "EXACT"]).optional(),
    runAsUser: z.string().nullable().optional(),
    runWithPassword: z.string().nullable().optional(),
    requireSerial: z.boolean().optional(),
    failOnError: z.boolean().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(["ASC", "DESC"]).optional(),
    timeoutMs: z.number().int().positive().optional(),
}).strict().partial();
const CreateBody = z.object({
    attrs: z.record(z.any()),
    options: OptionsSchema.optional()
});
const UpdateBody = z.object({
    attrs: z.record(z.any()),
    options: OptionsSchema.optional()
});
const SearchBody = z.object({
    filter: z.any().optional(),
    options: OptionsSchema.optional()
});
const SyncBody = z.object({
    objectClass: z.string(),
    token: z.object({ value: z.string() }).nullable().optional(),
    options: OptionsSchema.optional()
});
// ---- Helpers ----
function cleanOptions(o) {
    if (!o || typeof o !== "object")
        return undefined;
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
function getSpi(registry, id) {
    if (!id)
        return null;
    const inst = registry.get(id);
    if (!inst)
        return null;
    // Try common locations
    const candidates = [
        inst,
        inst.spi,
        inst.facade,
        inst.impl,
        inst.instance,
        inst.ops,
    ].filter(Boolean);
    // Pick the first candidate that has at least one core op
    for (const c of candidates) {
        if (typeof c?.schema === "function" || typeof c?.search === "function" ||
            typeof c?.get === "function" || typeof c?.create === "function" ||
            typeof c?.sync === "function") {
            return c;
        }
    }
    return null;
}
// ---- Router ----
export function buildRouter(registry) {
    const r = Router();
    // Reserved path segments (starting with '_') must not be treated as object classes
    r.param("objectClass", (req, res, next, value) => {
        if (value && value.startsWith("_"))
            return res.status(404).json({ error: "Unknown path" });
        return next();
    });
    // ---- underscore ops FIRST ----
    // Sync
    r.post("/:id/_sync", async (req, res, next) => {
        try {
            const { objectClass, token, options } = SyncBody.parse(req.body);
            const { id } = req.params;
            const spi = getSpi(registry, id);
            if (!spi)
                return res.status(404).json({ error: "Connector not found" });
            if (!spi.sync)
                return res.status(501).json({ error: "Sync not implemented" });
            const out = await spi.sync(objectClass, token ?? null, cleanOptions(options));
            res.json(out);
        }
        catch (e) {
            next(e);
        }
    });
    // Search (aggregates streaming)
    r.post("/:id/:objectClass/_search", async (req, res, next) => {
        try {
            const payload = SearchBody.parse(req.body);
            const { id, objectClass } = req.params;
            const spi = getSpi(registry, id);
            if (!spi)
                return res.status(404).json({ error: "Connector not found" });
            if (!spi.search)
                return res.status(501).json({ error: "Search not implemented" });
            const out = await spi.search(objectClass, payload.filter, cleanOptions(payload.options));
            res.json(out);
        }
        catch (e) {
            next(e);
        }
    });
    // UpdateAttributeValuesOp (optional)
    r.post("/:id/:objectClass/:uid/_addAttributeValues", async (req, res, next) => {
        try {
            const { attrs, options } = CreateBody.parse(req.body);
            const { id, objectClass, uid } = req.params;
            const spi = getSpi(registry, id);
            if (!spi)
                return res.status(404).json({ error: "Connector not found" });
            if (!spi.addAttributeValues)
                return res.status(501).json({ error: "UpdateAttributeValuesOp not implemented" });
            const out = await spi.addAttributeValues(objectClass, uid, attrs, cleanOptions(options));
            res.json(out);
        }
        catch (e) {
            next(e);
        }
    });
    r.post("/:id/:objectClass/:uid/_removeAttributeValues", async (req, res, next) => {
        try {
            const { attrs, options } = CreateBody.parse(req.body);
            const { id, objectClass, uid } = req.params;
            const spi = getSpi(registry, id);
            if (!spi)
                return res.status(404).json({ error: "Connector not found" });
            if (!spi.removeAttributeValues)
                return res.status(501).json({ error: "UpdateAttributeValuesOp not implemented" });
            const out = await spi.removeAttributeValues(objectClass, uid, attrs, cleanOptions(options));
            res.json(out);
        }
        catch (e) {
            next(e);
        }
    });
    // ---- Generic object routes (no inline regex; param guard handles '_' + order avoids conflicts) ----
    const oc = ":objectClass";
    // Create
    r.post(`/:id/${oc}`, async (req, res, next) => {
        try {
            const { attrs, options } = CreateBody.parse(req.body);
            const { id, objectClass } = req.params;
            const spi = getSpi(registry, id);
            if (!spi)
                return res.status(404).json({ error: "Connector not found" });
            if (!spi.create)
                return res.status(501).json({ error: "Create not implemented" });
            const out = await spi.create(objectClass, attrs, cleanOptions(options));
            res.status(201).json(out);
        }
        catch (e) {
            next(e);
        }
    });
    // Get
    r.get(`/:id/${oc}/:uid`, async (req, res, next) => {
        try {
            const { id, objectClass, uid } = req.params;
            const spi = getSpi(registry, id);
            if (!spi)
                return res.status(404).json({ error: "Connector not found" });
            if (!spi.get)
                return res.status(501).json({ error: "Get not implemented" });
            const out = await spi.get(objectClass, uid, req.query);
            if (!out)
                return res.status(404).json({ error: "Not found" });
            res.json(out);
        }
        catch (e) {
            next(e);
        }
    });
    // Update
    r.patch(`/:id/${oc}/:uid`, async (req, res, next) => {
        try {
            const { attrs, options } = UpdateBody.parse(req.body);
            const { id, objectClass, uid } = req.params;
            const spi = getSpi(registry, id);
            if (!spi)
                return res.status(404).json({ error: "Connector not found" });
            if (!spi.update)
                return res.status(501).json({ error: "Update not implemented" });
            const out = await spi.update(objectClass, uid, attrs, cleanOptions(options));
            res.json(out);
        }
        catch (e) {
            next(e);
        }
    });
    // Delete
    r.delete(`/:id/${oc}/:uid`, async (req, res, next) => {
        try {
            const { id, objectClass, uid } = req.params;
            const spi = getSpi(registry, id);
            if (!spi)
                return res.status(404).json({ error: "Connector not found" });
            if (!spi.delete)
                return res.status(501).json({ error: "Delete not implemented" });
            await spi.delete(objectClass, uid, req.query);
            res.status(204).end();
        }
        catch (e) {
            next(e);
        }
    });
    // Schema & Test
    r.get("/:id/schema", async (req, res, next) => {
        try {
            const { id } = req.params;
            const spi = getSpi(registry, id);
            if (!spi)
                return res.status(404).json({ error: "Connector not found" });
            if (!spi.schema)
                return res.status(501).json({ error: "Schema not implemented" });
            const out = await spi.schema();
            res.json(out);
        }
        catch (e) {
            next(e);
        }
    });
    r.post("/:id/_test", async (req, res, next) => {
        try {
            const { id } = req.params;
            const spi = getSpi(registry, id);
            if (!spi)
                return res.status(404).json({ error: "Connector not found" });
            if (!spi.test)
                return res.status(501).json({ error: "Test not implemented" });
            await spi.test();
            res.status(204).end();
        }
        catch (e) {
            next(e);
        }
    });
    return r;
}
