import type { ConnectorSpi, ConnectorConfig } from "../spi/types.js";
import type { Configuration } from "../spi/configuration.js";

type Factory = (config: ConnectorConfig) => Promise<ConnectorSpi>;
type ConfigBuilder = (raw: any) => Promise<Configuration>;

export interface ConnectorInstance { id: string; config: ConnectorConfig; impl: ConnectorSpi; }

export class ConnectorRegistry {
  private factories = new Map<string, Factory>();
  private instances = new Map<string, ConnectorInstance>();
  private configBuilders = new Map<string, ConfigBuilder>();

  registerFactory(type: string, factory: Factory) { this.factories.set(type, factory); }
  registerConfigBuilder(type: string, builder: ConfigBuilder) { this.configBuilders.set(type, builder); }

  async initInstance(id: string, type: string, rawConfig: ConnectorConfig) {
    const factory = this.factories.get(type);
    if (!factory) throw new Error(`Unknown connector type ${type}`);
    const builder = this.configBuilders.get(type);
    const configObj: any = builder ? await builder(rawConfig) : rawConfig;
    //console.log('[connector] config', configObj);
    if (configObj && typeof configObj.validate === "function") await configObj.validate();
    const spi = await factory({
      logger: console,
      config: configObj,
      instanceId: id,
      connectorId: type,
      type,
    });
    this.instances.set(id, { id, config: configObj, impl: spi });
    return this.instances.get(id)!;
    //const impl = await factory(configObj);
    //const inst: ConnectorInstance = { id, config: configObj, impl };
    //(inst.impl as any).id = id;
    //this.instances.set(id, inst);
    //return inst;
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
