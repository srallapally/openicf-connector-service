export function requireNonEmpty(name, v) {
    if (typeof v !== "string" || v.trim() === "") {
        throw new Error(`Configuration property '${name}' is required`);
    }
}
