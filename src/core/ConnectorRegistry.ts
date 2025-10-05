import type { ConnectorSpi, ConnectorConfig } from "../spi/types.js";
import type { Configuration } from "../spi/configuration.js";
import type { ConnectorKey } from "../loader/types.js";  // ← Import from loader types
import { toConnectorKey } from "../loader/types.js";     // ← Import helper

type Factory = (config: ConnectorConfig) => Promise<ConnectorSpi>;
type ConfigBuilder = (raw: any) => Promise<Configuration>;

export interface ConnectorInstance {
    id: string;
    connectorKey: ConnectorKey;  // ← Now uses imported type
    config: ConnectorConfig;
    impl: ConnectorSpi;
}

export class ConnectorRegistry {
  private factories = new Map<string, Factory>();
  private instances = new Map<string, ConnectorInstance>();
  private configBuilders = new Map<string, ConfigBuilder>();

  registerFactory(type: string, version: string, factory: Factory) {
        const key = toConnectorKey(type, version);  // ← Use helper
        this.factories.set(key, factory);
  }

  registerConfigBuilder(type: string, version: string, builder: ConfigBuilder) {
        const key = toConnectorKey(type, version);  // ← Use helper
        this.configBuilders.set(key, builder);
  }

  async initInstance(id: string, type: string, version: string, rawConfig: ConnectorConfig) {

    const key = toConnectorKey(type, version);
    const factory = this.factories.get(key);

    if (!factory)
          throw new Error(`Unknown connector type ${type}@${version}`);

    const builder = this.configBuilders.get(key);
    const configObj: any = builder ? await builder(rawConfig) : rawConfig;

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

    const connectorKey: ConnectorKey = { type, version };
    this.instances.set(id, { id, connectorKey, config: configObj, impl: spi });
    return this.instances.get(id)!;
  }
   getVersions(type: string): string[] {
        const versions: string[] = [];
        for (const key of this.factories.keys()) {
            if (key.startsWith(`${type}@`)) {
                versions.push(key.split('@')[1]!);
            }
        }
        return versions.sort();
    }

    // Helper: get latest version of a type
    getLatestVersion(type: string): string | undefined {
        const versions = this.getVersions(type);
        return versions[versions.length - 1];
    }

  get(id: string) {
    const inst = this.instances.get(id);
    if (!inst) throw new Error(`Connector ${id} not found`);
    return inst;
  }
  /** True if a connector with this id is loaded */
  has(id: string): boolean {
    return this.instances.has(id);
  }

  /** Iterator over loaded connector ids (matches Map.keys()) */
  keys(): IterableIterator<string> {
    return this.instances.keys();
  }

  /** Convenience: array of loaded connector ids */
  ids(): string[] {
    return Array.from(this.instances.keys());
  }

  /** (Optional) Get the SPI facade directly if you need it */
  getSpi(id: string) {
    return this.instances.get(id)?.impl;
  }

  /** (Optional) List full instances if needed for debugging/inspect */
  list(): ConnectorInstance[] {
    return Array.from(this.instances.values());
  }

}
