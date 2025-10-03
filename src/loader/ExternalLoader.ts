import { pathToFileURL } from "url";
import * as fs from "fs/promises";
import * as path from "path";
import { ConnectorRegistry } from "../core/ConnectorRegistry.js";

type Manifest = {
  connectors: Array<{
    type: string;
    module: string;
    configBuilder?: string;
    instances?: Array<{ id: string; config: any }>;
  }>;
};

export async function loadExternalConnectors(connectorsRoot: string, registry: ConnectorRegistry, manifestFile = "manifest.json") {
  const rootAbs = path.resolve(connectorsRoot);
  const manifestPath = path.join(rootAbs, manifestFile);
  const raw = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as Manifest;

  for (const entry of manifest.connectors || []) {
    const modPath = path.join(rootAbs, entry.module);
    const modUrl = pathToFileURL(modPath).href;
    const mod = await import(modUrl);
    const factory = mod.default || mod.factory;
    if (typeof factory !== "function") throw new Error(`Connector module ${entry.module} missing default export factory`);

    if (entry.configBuilder) {
      const cfgPath = path.join(rootAbs, entry.configBuilder);
      const cfgUrl = pathToFileURL(cfgPath).href;
      const cfgMod = await import(cfgUrl);
      const builder = cfgMod.buildConfiguration || cfgMod.buildGraphConfiguration || cfgMod.default;
      if (typeof builder === "function") registry.registerConfigBuilder(entry.type, builder);
    }

    registry.registerFactory(entry.type, factory);

    for (const inst of entry.instances || []) {
      await registry.initInstance(inst.id, entry.type, inst.config || {});
      console.log(`[external] registered ${entry.type} instance: ${inst.id}`);
    }
  }
}
