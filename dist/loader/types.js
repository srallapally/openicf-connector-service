// src/loader/types.ts
/**
 * Helper function to create a string key from type and version
 */
export function toConnectorKey(type, version) {
    return `${type}@${version}`;
}
/**
 * Helper function to parse a connector key string
 */
export function parseConnectorKey(key) {
    const parts = key.split('@');
    if (parts.length !== 2)
        return null;
    const type = parts[0];
    const version = parts[1];
    if (!type || !version)
        return null;
    return { type, version };
}
