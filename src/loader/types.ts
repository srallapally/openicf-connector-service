// src/loader/types.ts

/**
 * Instance configuration definition.
 * Each instance represents a running connector with specific configuration.
 */
export interface InstanceDef {
    /** Unique identifier for this connector instance */
    id: string;

    /** Instance-specific configuration (merged with base config) */
    config?: Record<string, unknown>;

    /**
     * Optional: Override the connector version for this instance.
     * If not specified, uses the version from the manifest.
     */
    connectorVersion?: string;
}

/**
 * Array of instance definitions
 */
export type Instances = InstanceDef[];

/**
 * Connector manifest structure.
 * Each connector directory must contain a manifest.json following this schema.
 */
export interface Manifest {
    /** Unique identifier for this connector distribution */
    id: string;

    /** Connector type (e.g., "msgraph", "salesforce") */
    type: string;

    /** Semantic version of this connector (e.g., "1.0.0", "2.1.0") */
    version: string;

    /** Relative path to the entry point module (e.g., "./index.js") */
    entry: string;

    /** Optional: Relative path to configuration builder module */
    config?: string;

    /**
     * Optional: Pre-configured instances to bootstrap.
     * If not provided, instances can be configured via environment variables.
     */
    instances?: InstanceDef[];
}

/**
 * Composite key identifying a specific connector type and version
 */
export interface ConnectorKey {
    type: string;
    version: string;
}

/**
 * Helper function to create a string key from type and version
 */
export function toConnectorKey(type: string, version: string): string {
    return `${type}@${version}`;
}

/**
 * Helper function to parse a connector key string
 */
export function parseConnectorKey(key: string): ConnectorKey | null {
    const parts = key.split('@');
    if (parts.length !== 2) return null;

    const type = parts[0];
    const version = parts[1];

    if (!type || !version) return null;

    return { type, version };
}