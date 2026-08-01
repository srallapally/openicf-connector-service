import type { ConnectorSpi, ConnectorConfig } from "../spi/types.js";
import type { Configuration } from "../spi/configuration.js";
import type { ConnectorKey, ConnectorCapabilities } from "../loader/types.js";  // ← Import from loader types
import { toConnectorKey, resolveCapabilities } from "../loader/types.js";
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
    /** Manifest capability flags for this connector type and version. */
    capabilities: ConnectorCapabilities;
}

/**
 * A registered instance that has not necessarily been constructed yet.
 *
 * Registration records what an instance *would* be; materialization runs the
 * config builder and the factory. Splitting them is what lets a deployment
 * with a thousand connector instances boot in seconds instead of minutes, and
 * avoids a thundering herd of connections to targets nobody has asked for.
 */
export interface InstanceDefinition {
    id: string;
    type: string;
    version: string;
    rawConfig: ConnectorConfig;
    runtime: ResolvedRuntimeConfig;
}

export class ConnectorRegistry {
  private factories = new Map<string, Factory>();
  private instances = new Map<string, ConnectorInstance>();
  private definitions = new Map<string, InstanceDefinition>();
  private configBuilders = new Map<string, ConfigBuilder>();
  private capabilities = new Map<string, ConnectorCapabilities>();

  /**
   * In-flight materializations, keyed by instance id.
   *
   * The promise is stored before the first await, so two concurrent callers
   * share one factory invocation rather than each building their own connector
   * and one silently overwriting the other.
   */
  private materializing = new Map<string, Promise<ConnectorInstance>>();

  registerFactory(type: string, version: string, factory: Factory) {
        const key = toConnectorKey(type, version);  // ← Use helper
        this.factories.set(key, factory);
  }

  registerConfigBuilder(type: string, version: string, builder: ConfigBuilder) {
        const key = toConnectorKey(type, version);  // ← Use helper
        this.configBuilders.set(key, builder);
  }

  /**
   * Record a connector's manifest capability flags.
   *
   * Keyed by type and version rather than by instance: the flags describe what
   * the connector code can do, which cannot vary between two instances of the
   * same build.
   */
  registerCapabilities(
      type: string,
      version: string,
      caps: Partial<ConnectorCapabilities>,
  ): void {
    this.capabilities.set(toConnectorKey(type, version), resolveCapabilities(caps));
  }

  /** Capability flags for a connector, defaulting every flag to false. */
  getCapabilities(type: string, version: string): ConnectorCapabilities {
    return this.capabilities.get(toConnectorKey(type, version)) ?? resolveCapabilities({});
  }

  /**
   * Capability flags for a registered instance.
   *
   * Available without materializing, so the dispatcher can decide whether a
   * create is eligible for read-back before it builds anything.
   */
  capabilitiesOf(instanceId: string): ConnectorCapabilities {
    const built = this.instances.get(instanceId);
    if (built) return built.capabilities;
    const def = this.definitions.get(instanceId);
    if (!def) return resolveCapabilities({});
    return this.getCapabilities(def.type, def.version);
  }

  /**
   * Record an instance without constructing it.
   *
   * Runs only the checks that are free: duplicate detection and runtime config
   * validation. The config builder and the connector factory are deferred to
   * {@link materializeInstance}, so registering a thousand instances costs a
   * thousand map writes rather than a thousand connections.
   *
   * Runtime config is still validated here. A bad deadline or budget is an
   * operator error in the deployment descriptor and should surface at boot,
   * not on the first operation that happens to read the bad setting.
   */
  registerInstance(
      id: string,
      type: string,
      version: string,
      rawConfig: ConnectorConfig,
      runtimeConfig?: RuntimeConfigInput,
  ): InstanceDefinition {
    this.assertNotRegistered(id, type, version);

    let runtime: ResolvedRuntimeConfig;
    try {
      runtime = resolveRuntimeConfig(runtimeConfig);
    } catch (e) {
      throw new Error(`Connector instance '${id}': ${(e as Error).message}`, { cause: e });
    }

    const def: InstanceDefinition = { id, type, version, rawConfig, runtime };
    this.definitions.set(id, def);
    return def;
  }

  /**
   * Reject a duplicate before anything with side effects runs.
   *
   * Overwriting silently orphaned the previous instance without ever running
   * its lifecycle teardown, so a replacement has to go through
   * disposeInstance() first.
   */
  private assertNotRegistered(id: string, type: string, version: string): void {
    const existing = this.instances.get(id);
    if (existing) {
      throw new Error(
        `Connector instance '${id}' already registered as ` +
        `${existing.connectorKey.type}@${existing.connectorKey.version}; ` +
        `refusing to overwrite with ${type}@${version}. ` +
        `Call disposeInstance('${id}') first to replace it.`
      );
    }
    const def = this.definitions.get(id);
    if (def) {
      throw new Error(
        `Connector instance '${id}' already registered as ${def.type}@${def.version}; ` +
        `refusing to overwrite with ${type}@${version}. ` +
        `Call disposeInstance('${id}') first to replace it.`
      );
    }
  }

  /**
   * Construct a registered instance, or return the one already built.
   *
   * Concurrent callers share a single factory invocation: the in-flight
   * promise is published before the first await, so there is no window in
   * which two callers both observe "not built yet" and each build one.
   */
  async materializeInstance(id: string): Promise<ConnectorInstance> {
    const built = this.instances.get(id);
    if (built) return built;

    const inFlight = this.materializing.get(id);
    if (inFlight) return inFlight;

    const def = this.definitions.get(id);
    if (!def) throw new Error(`Connector instance '${id}' is not registered`);

    const promise = this.buildInstance(def);
    this.materializing.set(id, promise);
    try {
      return await promise;
    } finally {
      this.materializing.delete(id);
    }
  }

  /**
   * Build a fresh, uncached SPI for a registered instance.
   *
   * Used by the connection pool, which needs N independent connectors for one
   * instance. Deliberately does not touch the instances map: these are pool
   * resources whose lifecycle belongs to the pool, and caching one of them as
   * "the" instance would leave it disposed out from under the pool.
   */
  async createSpi(instanceId: string): Promise<ConnectorSpi> {
    const def = this.definitions.get(instanceId);
    if (!def) throw new Error(`Connector instance '${instanceId}' is not registered`);

    const key = toConnectorKey(def.type, def.version);
    const factory = this.factories.get(key);
    if (!factory) throw new Error(`Unknown connector type ${def.type}@${def.version}`);

    const builder = this.configBuilders.get(key);
    const configObj: any = builder ? await builder(def.rawConfig) : def.rawConfig;
    if (configObj && typeof configObj.validate === "function") await configObj.validate();

    return factory({
      logger: console,
      config: configObj,
      instanceId: def.id,
      connectorId: def.type,
      connectorVersion: def.version,
      type: def.type,
    });
  }

  private async buildInstance(def: InstanceDefinition): Promise<ConnectorInstance> {
    const { id, type, version, rawConfig, runtime } = def;
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
    const instance: ConnectorInstance = {
      id, type, connectorKey, config: configObj, impl: spi, runtime,
      capabilities: this.getCapabilities(type, version),
    };
    this.instances.set(id, instance);
    return instance;
  }

  /**
   * Register an instance and construct it immediately.
   *
   * The eager path, kept as the default so existing callers -- which read
   * `.impl` straight off the returned instance -- are unaffected. Callers that
   * want lazy construction register with {@link registerInstance} and let
   * ConnectorManager materialize on first use.
   */
  async initInstance(
      id: string,
      type: string,
      version: string,
      rawConfig: ConnectorConfig,
      runtimeConfig?: RuntimeConfigInput,
  ): Promise<ConnectorInstance> {
    this.registerInstance(id, type, version, rawConfig, runtimeConfig);
    try {
      return await this.materializeInstance(id);
    } catch (e) {
      // A failed construction must not leave a definition behind claiming the
      // id: the caller saw this throw and will reasonably retry with the same
      // or a corrected configuration.
      this.definitions.delete(id);
      throw e;
    }
  }

  /** The definition for a registered instance, built or not. */
  getDefinition(id: string): InstanceDefinition | undefined {
    return this.definitions.get(id);
  }

  /** Ids of every registered instance, whether or not it has been constructed. */
  registeredIds(): string[] {
    return Array.from(this.definitions.keys());
  }

  /** True if the instance has been constructed, as opposed to merely registered. */
  isMaterialized(id: string): boolean {
    return this.instances.has(id);
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

  /**
   * (Optional) Get the SPI facade directly if you need it
   *
   * @deprecated Prefer `ConnectorManager.acquire()`, which hands back a leased
   * {@link ConnectorFacade} rather than the raw SPI. A raw SPI reference
   * bypasses the circuit breaker, the deadline, and the refcount that keeps an
   * instance from being evicted while still in use, and it cannot be revoked
   * once handed out. Retained because the websocket package still relies on it.
   */
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
    // The definition goes regardless of whether the instance was ever
    // constructed: disposal releases the id, and a registered-but-unbuilt
    // instance would otherwise keep claiming it forever.
    this.definitions.delete(id);
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
