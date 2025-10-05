// ExternalLoader.ts
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
//type InstanceDef = { id: string; config?: Record<string, unknown> };
//type Instances = InstanceDef[];
//type Manifest = {
//  id: string;
//  type: string;
//  entry: string;
//  config?: string;
//  instances?: Array<{ id: string; config?: Record<string, unknown> }>;
//};
function resolveEnvStrings(val) {
    if (typeof val === "string") {
        const m = val.match(/^\$\{([A-Z0-9_]+)\}$/);
        if (m) {
            // Narrow the key to string
            const key = m[1];
            if (!key)
                throw new Error("Regex capture failed to produce a key");
            const env = process.env;
            const rep = env[key];
            if (rep === undefined)
                throw new Error(`Missing environment variable ${m[1]}`);
            return rep;
        }
        return val;
    }
    if (Array.isArray(val))
        return val.map(v => resolveEnvStrings(v));
    if (val && typeof val === "object") {
        const out = {};
        for (const [k, v] of Object.entries(val))
            out[k] = resolveEnvStrings(v);
        return out;
    }
    return val;
}
async function readInstancesJson(dir) {
    try {
        const txt = await fs.readFile(path.join(dir, "instances.json"), "utf8");
        const arr = JSON.parse(txt);
        if (!Array.isArray(arr))
            throw new Error("instances.json must be an array");
        return arr;
    }
    catch {
        return null;
    }
}
function readInstancesEnv(manifestId, type) {
    const byId = (process.env[`CONNECTOR_INSTANCES_${manifestId.toUpperCase()}`] ?? "").trim();
    if (byId) {
        const arr = JSON.parse(byId);
        if (!Array.isArray(arr))
            throw new Error("CONNECTOR_INSTANCES_<ID> must be a JSON array");
        return arr;
    }
    const global = (process.env.CONNECTOR_INSTANCES ?? "").trim();
    if (global) {
        const arr = JSON.parse(global);
        if (!Array.isArray(arr))
            throw new Error("CONNECTOR_INSTANCES must be a JSON array");
        return arr
            .filter((x) => x && typeof x === "object")
            .filter((x) => !x.type || x.type === type)
            .map((x) => ({ id: x.id, config: x.config }));
    }
    return null;
}
export async function loadExternalConnectors(connectorsDir, registry) {
    const entries = await fs.readdir(connectorsDir, { withFileTypes: true });
    for (const d of entries) {
        if (!d.isDirectory())
            continue;
        const dir = path.join(connectorsDir, d.name);
        const manifestPath = path.join(dir, "manifest.json");
        let manifest;
        try {
            manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
            if (!manifest.id || !manifest.type || !manifest.entry || !manifest.version) {
                console.warn(`[external] Invalid manifest (missing version): ${manifestPath}`);
                continue;
            }
        }
        catch (e) {
            console.warn(`[external] skipping ${d.name}: cannot read manifest.json (${e?.message || e})`);
            continue;
        }
        try {
            const modUrl = pathToFileURL(path.join(dir, manifest.entry)).href;
            const mod = await import(modUrl);
            if (typeof mod.default !== "function") {
                console.warn(`[external] ${manifest.id}: default export is not a factory function`);
                continue;
            }
            const type = (manifest.type ?? manifest.id ?? d.name).trim();
            const version = manifest.version.trim();
            await registry.registerFactory(type, version, mod.default);
            console.log(`[external] loaded connector: ${type}@${version}`);
            let baseCfg = {};
            let buildConfiguration;
            if (manifest.config) {
                const cfgUrl = pathToFileURL(path.join(dir, manifest.config)).href;
                const cfgMod = await import(cfgUrl);
                baseCfg = (cfgMod.default ?? cfgMod) || {};
                if (cfgMod) {
                    if (typeof cfgMod.buildConfiguration === 'function') {
                        buildConfiguration = cfgMod.buildConfiguration;
                    }
                    else if (typeof cfgMod.default === 'function') {
                        buildConfiguration = cfgMod.default;
                    }
                    else if (cfgMod.default && typeof cfgMod.default === 'object') {
                        baseCfg = cfgMod.default; // plain object default export
                    }
                }
            }
            // 3) Bootstrap instances from (a) manifest.instances, (b) instances.json, (c) ENV
            let instances = manifest.instances ?? null;
            //if (!instances) instances = await readInstancesJson(dir);
            //if (!instances) instances = readInstancesEnv(manifest.id, manifest.type);
            if (!instances || instances.length === 0) {
                console.warn(`[external] ${manifest.id}: no instances defined`);
            }
            else {
                for (const inst of instances) {
                    const instanceVersion = inst.connectorVersion ?? version;
                    //const mergedCfg = resolveEnvStrings({ ...(baseCfg || {}), ...(inst.config || {}) });
                    const mergedRaw = { ...baseCfg, ...(inst.config || {}) };
                    const effectiveCfg = buildConfiguration ? await buildConfiguration(mergedRaw) : mergedRaw;
                    await registry.initInstance(inst.id, manifest.type, instanceVersion, effectiveCfg);
                    console.log(`[external] registered ${manifest.type}@${instanceVersion} instance: ${inst.id}`);
                }
            }
        }
        catch (e) {
            console.error(`[external] failed to load ${manifest.id}: ${e?.message || e}`);
        }
    }
}
