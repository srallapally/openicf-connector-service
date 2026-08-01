// src/loader/types.ts

import type { RuntimeConfigInput } from "../config/runtime.js";

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

    /**
     * Optional: framework-level tuning for this instance -- attempt deadlines,
     * concurrency budgets, the interactive slice, target rate limits, read
     * caching.
     *
     * Deliberately separate from `config`, which is the connector's own
     * settings and is passed through to the factory untouched. These are the
     * framework's knobs and are never handed to the connector.
     */
    runtime?: RuntimeConfigInput;
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

    /**
     * Declares that the connector holds a stateful protocol connection
     * (LDAP, SQL, SSH) and should be run through a connection pool.
     *
     * Stateless connectors -- REST in particular -- gain nothing from pooling
     * and get an HTTP keep-alive agent instead.
     */
    poolable?: boolean;

    /**
     * Declares that this connector's delta update operations
     * (`addAttributeValues` / `removeAttributeValues`) are safe to apply twice.
     *
     * Gates retry after an indeterminate delta update. Full-replace updates
     * are idempotent by construction and are always retryable; a delta that
     * increments, appends, or toggles is not, and replaying it silently
     * corrupts the target. Default false, because the unsafe case is the one
     * that must not happen by accident.
     */
    idempotentDelta?: boolean;

    /**
     * Declares that the connector supports an equality filter on the naming
     * attribute.
     *
     * Enables the create read-back: when a create times out, the dispatcher
     * searches for the object by name to find out whether it landed. Without
     * it a timed-out create can only be recorded INDETERMINATE and left for
     * reconciliation.
     */
    equalitySearchOnName?: boolean;
}

/**
 * Manifest capability flags with defaults applied.
 *
 * All three default false: every flag asserts a property the framework will
 * rely on, and an absent assertion has to read as "no".
 */
export interface ConnectorCapabilities {
    poolable: boolean;
    idempotentDelta: boolean;
    equalitySearchOnName: boolean;
}

/** Read the capability flags off a manifest, defaulting each to false. */
export function resolveCapabilities(manifest: Pick<Manifest, "poolable" | "idempotentDelta" | "equalitySearchOnName">): ConnectorCapabilities {
    return {
        poolable: manifest.poolable === true,
        idempotentDelta: manifest.idempotentDelta === true,
        equalitySearchOnName: manifest.equalitySearchOnName === true,
    };
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