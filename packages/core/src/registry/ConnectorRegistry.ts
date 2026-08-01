import type { ConnectorSpi, ConnectorConfig } from "../spi/types.js";
import type { Configuration } from "../spi/configuration.js";
import type { ConnectorKey } from "../loader/types.js";  // ← Import from loader types
import { toConnectorKey } from "../loader/types.js";
import type { RuntimeConfigInput, ResolvedRuntimeConfig } from "../config/runtime.js";
import { resolveRuntimeConfig } from "../config/runtime.js";
import semver from "semver";
import { redactSecrets } from "./redact.js";

type Factory = (config: ConnectorConfig) => Promise<ConnectorSpi>;
type ConfigBuilder = (raw: any) => Promise<Configuration>;

export interface ConnectorInstance {
    id: string;
    type: string;
    connectorKey: ConnectorKey;  // ← Now uses imported type
    config: ConnectorConfig;
    impl: ConnectorSpi;
    /** Framework tuning for this instance, with defaults applied. */
    runtime: ResolvedRuntimeConfig;
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

  async initInstance(
      id: string,
      type: string,
      version: string,
      rawConfig: ConnectorConfig,
      runtimeConfig?: RuntimeConfigInput,
  ) {

    // Reject before building config: a rejected duplicate must not execute the
    // new configuration's side effects. Overwriting silently orphaned the
    // previous instance without ever running its lifecycle teardown.
    const existing = this.instances.get(id);
    if (existing) {
      throw new Error(
        `Connector instance '${id}' already registered as ` +
        `${existing.connectorKey.type}@${existing.connectorKey.version}; ` +
        `refusing to overwrite with ${type}@${version}. ` +
        `Call disposeInstance('${id}') first to replace it.`
      );
    }

    // Validate framework tuning before anything with side effects runs. A bad
    // deadline or budget is an operator error in the deployment descriptor, and
    // it should surface at registration rather than on the first operation that
    // happens to read the bad setting.
    let runtime: ResolvedRuntimeConfig;
    try {
      runtime = resolveRuntimeConfig(runtimeConfig);
    } catch (e) {
      throw new Error(`Connector instance '${id}': ${(e as Error).message}`, { cause: e });
    }

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
    this.instances.set(id, { id, type, connectorKey, config: configObj, impl: spi, runtime });
    return this.instances.get(id)!;
  }
    getVersions(type: string): string[] {
        return Array.from(this.factories.keys())
            .filter(k => k.startsWith(type + '@'))
            .map(k => k.split('@')[1]!)
            .sort((a, b) => semver.compare(a, b));  // ← Handles all semver edge cases
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

  /**
   * List loaded instances for debugging and inspection.
   *
   * Configurations are redacted: secret-looking keys and any GuardedString
   * become "***". Listings end up in logs and diagnostic payloads, so the
   * default here is the safe one. `get()` and `getSpi()` are unredacted --
   * operations need the real configuration, listings do not.
   */
  list(): ConnectorInstance[] {
    return Array.from(this.instances.values()).map(inst => ({
      ...inst,
      config: redactSecrets(inst.config),
    }));
  }

  /**
   * Dispose one instance and remove it from the registry. Never throws.
   *
   * An unknown id is a silent no-op, matching the tolerance of `has()` and
   * `getSpi()` rather than the throwing behaviour of `get()`. This is
   * deliberate: disposal is teardown, and teardown should not fail because
   * something was already gone.
   *
   * The instance is removed in a `finally`, so it leaves the map whether
   * `dispose()` resolves, rejects, or is absent entirely. That removal-always
   * rule is what makes `disposeAll()` inherently idempotent.
   */
  async disposeInstance(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) return;
    try {
      await inst.impl.dispose?.();
    } catch (e) {
      console.error(`[registry] dispose failed for instance ${id}: ${(e as Error).message}`);
    } finally {
      this.instances.delete(id);
    }
  }

  /**
   * Dispose every instance. Second call iterates an empty map (no-op).
   *
   * Sequential rather than `Promise.all`: connectors may share process-level
   * resources and nothing requires parallel teardown. Keys are snapshotted
   * before iterating so the intent is unambiguous while entries are deleted.
   */
  async disposeAll(): Promise<void> {
    for (const id of Array.from(this.instances.keys())) {
      await this.disposeInstance(id);
    }
  }

}
