// ExternalLoader.ts
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
// import types that fit your project:
import type { ConnectorRegistry } from "../core/ConnectorRegistry.js";
type InstanceDef = { id: string; config?: Record<string, unknown> };
type Instances = InstanceDef[];

type Manifest = {
  id: string;
  type: string;
  entry: string;
  config?: string;
  instances?: Array<{ id: string; config?: Record<string, unknown> }>;
};

function resolveEnvStrings<T>(val: T): T {
  if (typeof val === "string") {
    const m = val.match(/^\$\{([A-Z0-9_]+)\}$/);
    if (m) {
      // Narrow the key to string
      const key = m[1];
      if (!key) throw new Error("Regex capture failed to produce a key");

      const env = process.env as Record<string, string | undefined>;
      const rep = env[key];
      if (rep === undefined) throw new Error(`Missing environment variable ${m[1]}`);
      return rep as unknown as T;
    }
    return val;
  }
  if (Array.isArray(val)) return val.map(v => resolveEnvStrings(v)) as unknown as T;
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) out[k] = resolveEnvStrings(v);
    return out as unknown as T;
  }
  return val;
}

async function readInstancesJson(dir: string): Promise<Instances | null> {
  try {
    const txt = await fs.readFile(path.join(dir, "instances.json"), "utf8");
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) throw new Error("instances.json must be an array");
    return arr as Instances;
  } catch {
    return null;
  }
}

function readInstancesEnv(manifestId: string, type: string): Instances | null {
  const byId = (process.env[`CONNECTOR_INSTANCES_${manifestId.toUpperCase()}`] ?? "").trim();
  if (byId) {
    const arr = JSON.parse(byId);
    if (!Array.isArray(arr)) throw new Error("CONNECTOR_INSTANCES_<ID> must be a JSON array");
    return arr as Instances;
  }
  const global = (process.env.CONNECTOR_INSTANCES ?? "").trim();
  if (global) {
    const arr = JSON.parse(global);
    if (!Array.isArray(arr)) throw new Error("CONNECTOR_INSTANCES must be a JSON array");
    return arr
        .filter((x: any) => x && typeof x === "object")
        .filter((x: any) => !x.type || x.type === type)
        .map((x: any) => ({ id: x.id, config: x.config })) as Instances;
  }
  return null;
}

export async function loadExternalConnectors(connectorsDir: string, registry: ConnectorRegistry) {
  const entries = await fs.readdir(connectorsDir, { withFileTypes: true });

  for (const d of entries) {
    if (!d.isDirectory()) continue;

    const dir = path.join(connectorsDir, d.name);
    const manifestPath = path.join(dir, "manifest.json");
    console.log(`loadExternalConnectors ${manifestPath}`);
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (!manifest.id || !manifest.type || !manifest.entry) {
        console.warn(`[external] Invalid manifest: ${manifestPath}`);
        continue;
      }
    } catch (e: any) {
      console.warn(`[external] skipping ${d.name}: cannot read manifest.json (${e?.message || e})`);
      continue;
    }

    try {
      // 1) Load module
      const modUrl = pathToFileURL(path.join(dir, manifest.entry)).href;
      const mod = await import(modUrl);
      if (typeof mod.default !== "function") {
        console.warn(`[external] ${manifest.id}: default export is not a factory function`);
        continue;
      }
      const type = (manifest.type ?? manifest.id ?? d.name).trim();
      await registry.registerFactory(type, mod.default);          // <-- move this up here
      console.log(`[external] loaded connector factory: ${type}`);

      // 2) Optional config module
      let baseCfg: any = {};
      let buildConfiguration: ((raw:any)=>Promise<any>) | undefined;

      if (manifest.config) {
        const cfgUrl = pathToFileURL(path.join(dir, manifest.config)).href;
        const cfgMod = await import(cfgUrl);
        baseCfg = (cfgMod.default ?? cfgMod) || {};
        if(cfgMod){
          if (typeof cfgMod.buildConfiguration === 'function') {
            buildConfiguration = cfgMod.buildConfiguration;
          } else if (typeof cfgMod.default === 'function') {
            buildConfiguration = cfgMod.default;
          } else if (cfgMod.default && typeof cfgMod.default === 'object') {
            baseCfg = cfgMod.default; // plain object default export
          }
        }
      }

      // 3) Bootstrap instances from (a) manifest.instances, (b) instances.json, (c) ENV
      let instances: Instances | null = manifest.instances ?? null;
      //if (!instances) instances = await readInstancesJson(dir);
      //if (!instances) instances = readInstancesEnv(manifest.id, manifest.type);

      if (!instances || instances.length === 0) {
        console.warn(`[external] ${manifest.id}: no instances defined`);
      } else {
        for (const inst of instances) {
          const mergedCfg = resolveEnvStrings({ ...(baseCfg || {}), ...(inst.config || {}) });
          const mergedRaw = { ...baseCfg, ...(inst.config || {}) };
          const effectiveCfg = buildConfiguration ? await buildConfiguration(mergedRaw) : mergedRaw;

          //if (effectiveCfg?.validate instanceof Function) {
          //  await effectiveCfg.validate();       // ← "In validate ..." will log here
          //}
          //await registry.initInstance(inst.id, manifest.type, mergedCfg);
          await registry.initInstance(inst.id, manifest.type, effectiveCfg);
          console.log(`[external] registered ${manifest.type} instance: ${inst.id}`);
        }
      }
    } catch (e: any) {
      console.error(`[external] failed to load ${manifest.id}: ${e?.message || e}`);
    }
  }
}