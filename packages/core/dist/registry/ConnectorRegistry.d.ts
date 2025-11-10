import type { ConnectorSpi, ConnectorConfig } from "../spi/types.js";
import type { Configuration } from "../spi/configuration.js";
import type { ConnectorKey } from "../loader/types.js";
type Factory = (config: ConnectorConfig) => Promise<ConnectorSpi>;
type ConfigBuilder = (raw: any) => Promise<Configuration>;
export interface ConnectorInstance {
    id: string;
    type: string;
    connectorKey: ConnectorKey;
    config: ConnectorConfig;
    impl: ConnectorSpi;
}
export declare class ConnectorRegistry {
    private factories;
    private instances;
    private configBuilders;
    registerFactory(type: string, version: string, factory: Factory): void;
    registerConfigBuilder(type: string, version: string, builder: ConfigBuilder): void;
    initInstance(id: string, type: string, version: string, rawConfig: ConnectorConfig): Promise<ConnectorInstance>;
    getVersions(type: string): string[];
    getLatestVersion(type: string): string | undefined;
    get(id: string): ConnectorInstance;
    /** True if a connector with this id is loaded */
    has(id: string): boolean;
    /** Iterator over loaded connector ids (matches Map.keys()) */
    keys(): IterableIterator<string>;
    /** Convenience: array of loaded connector ids */
    ids(): string[];
    /** (Optional) Get the SPI facade directly if you need it */
    getSpi(id: string): Partial<import("../spi/types.js").CreateOp & import("../spi/types.js").UpdateOp & import("../spi/types.js").DeleteOp & import("../spi/types.js").GetOp & import("../spi/types.js").SearchOp & import("../spi/types.js").SchemaOp & import("../spi/types.js").TestOp & import("../spi/types.js").SyncOp & import("../spi/types.js").ScriptOnConnectorOp & import("../spi/types.js").ResolveUsernameOp & import("../spi/types.js").ValidateOp & import("../index.js").AuthenticateOp & import("../index.js").BatchOp & import("../index.js").UpdateAttributeValuesOp & import("../index.js").ScriptOnResourceOp & import("../index.js").ConnectorEventSubscriptionOp & import("../index.js").SyncEventSubscriptionOp> | undefined;
    /** (Optional) List full instances if needed for debugging/inspect */
    list(): ConnectorInstance[];
}
export {};
//# sourceMappingURL=ConnectorRegistry.d.ts.map