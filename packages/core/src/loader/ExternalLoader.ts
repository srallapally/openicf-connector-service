// ExternalLoader.ts
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ConnectorRegistry } from "../registry/ConnectorRegistry.js";
import type { Manifest, InstanceDef, Instances } from "./types.js";


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

/**
 * Read instances.json from a connector directory.
 *
 * An absent file is a normal configuration choice and returns null silently.
 * A file that exists but cannot be parsed is an operator error and is logged
 * with the reason, so a typo is distinguishable from "no file". Either way the
 * loader falls through rather than throwing: a bad file in one connector must
 * not stop the others.
 */
async function readInstancesJson(dir: string, manifestId: string): Promise<Instances | null> {
  let txt: string;
  try {
    txt = await fs.readFile(path.join(dir, "instances.json"), "utf8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      console.error(`[external] ${manifestId}: cannot read instances.json: ${e?.message || e}`);
    }
    return null;
  }

  try {
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) throw new Error("instances.json must be an array");
    return arr as Instances;
  } catch (e: any) {
    console.error(`[external] ${manifestId}: invalid instances.json: ${e?.message || e}`);
    return null;
  }
}

export async function loadExternalConnectors(connectorsDir: string, registry: ConnectorRegistry) {
  const entries = await fs.readdir(connectorsDir, { withFileTypes: true });

  for (const d of entries) {
    if (!d.isDirectory()) continue;

    const dir = path.join(connectorsDir, d.name);
    const manifestPath = path.join(dir, "manifest.json");

    let manifest: Manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (!manifest.id || !manifest.type || !manifest.entry || !manifest.version) {
            console.warn(`[external] Invalid manifest (missing version): ${manifestPath}`);
            continue;
      }
    } catch (e: any) {
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
      await registry.registerFactory(type,version, mod.default);
      console.log(`[external] loaded connector: ${type}@${version}`);


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

      // Bootstrap instances: manifest.instances wins if present, otherwise
      // instances.json. The two are never merged -- a silent merge is exactly
      // where duplicate instance ids would come from, and those are now a hard
      // error at registration.
      let instances: Instances | null = manifest.instances ?? null;
      if (!instances) instances = await readInstancesJson(dir, manifest.id);

      if (!instances || instances.length === 0) {
        console.warn(`[external] ${manifest.id}: no instances defined`);
      } else {
        for (const inst of instances) {
          const instanceVersion = inst.connectorVersion ?? version;
          //const mergedCfg = resolveEnvStrings({ ...(baseCfg || {}), ...(inst.config || {}) });
          //const mergedRaw = { ...baseCfg, ...(inst.config || {}) };
          //const effectiveCfg = buildConfiguration ? await buildConfiguration(mergedRaw) : mergedRaw;
          const mergedCfg = resolveEnvStrings({ ...baseCfg, ...(inst.config || {}) });
          const effectiveCfg = buildConfiguration ? await buildConfiguration(mergedCfg) : mergedCfg;
          await registry.initInstance(inst.id, manifest.type, instanceVersion, effectiveCfg);
          console.log(`[external] registered ${manifest.type}@${instanceVersion} instance: ${inst.id}`);
        }
      }
    } catch (e: any) {
      console.error(`[external] failed to load ${manifest.id}: ${e?.message || e}`);
    }
  }
}