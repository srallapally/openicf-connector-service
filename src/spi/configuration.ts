export interface Configuration {
  validate(): void | Promise<void>;
}

export function requireNonEmpty(name: string, v: unknown) {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`Configuration property '${name}' is required`);
  }
}
