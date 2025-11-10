import { toConnectorKey } from "../loader/types.js";
import semver from "semver";
export class ConnectorRegistry {
    factories = new Map();
    instances = new Map();
    configBuilders = new Map();
    registerFactory(type, version, factory) {
        const key = toConnectorKey(type, version); // ← Use helper
        this.factories.set(key, factory);
    }
    registerConfigBuilder(type, version, builder) {
        const key = toConnectorKey(type, version); // ← Use helper
        this.configBuilders.set(key, builder);
    }
    async initInstance(id, type, version, rawConfig) {
        const key = toConnectorKey(type, version);
        const factory = this.factories.get(key);
        if (!factory)
            throw new Error(`Unknown connector type ${type}@${version}`);
        const builder = this.configBuilders.get(key);
        const configObj = builder ? await builder(rawConfig) : rawConfig;
        if (configObj && typeof configObj.validate === "function")
            await configObj.validate();
        const spi = await factory({
            logger: console,
            config: configObj,
            instanceId: id,
            connectorId: type,
            connectorVersion: version,
            type,
        });
        const connectorKey = { type, version };
        this.instances.set(id, { id, type, connectorKey, config: configObj, impl: spi });
        return this.instances.get(id);
    }
    /*
     getVersions(type: string): string[] {
          const versions: string[] = [];
          for (const key of this.factories.keys()) {
              if (key.startsWith(`${type}@`)) {
                  versions.push(key.split('@')[1]!);
              }
          }
          return versions.sort();
      }
  */
    getVersions(type) {
        return Array.from(this.factories.keys())
            .filter(k => k.startsWith(type + '@'))
            .map(k => k.split('@')[1])
            .sort((a, b) => semver.compare(a, b)); // ← Handles all semver edge cases
    }
    // Helper: get latest version of a type
    getLatestVersion(type) {
        const versions = this.getVersions(type);
        return versions[versions.length - 1];
    }
    get(id) {
        const inst = this.instances.get(id);
        if (!inst)
            throw new Error(`Connector ${id} not found`);
        return inst;
    }
    /** True if a connector with this id is loaded */
    has(id) {
        return this.instances.has(id);
    }
    /** Iterator over loaded connector ids (matches Map.keys()) */
    keys() {
        return this.instances.keys();
    }
    /** Convenience: array of loaded connector ids */
    ids() {
        return Array.from(this.instances.keys());
    }
    /** (Optional) Get the SPI facade directly if you need it */
    getSpi(id) {
        return this.instances.get(id)?.impl;
    }
    /** (Optional) List full instances if needed for debugging/inspect */
    list() {
        return Array.from(this.instances.values());
    }
}
//# sourceMappingURL=ConnectorRegistry.js.map