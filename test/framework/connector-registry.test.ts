import { describe, expect, it, vi } from "vitest";

function compareVersions(a: string, b: string): number {
  const [acore, apre] = a.split("-");
  const [bcore, bpre] = b.split("-");
  const aparts = acore.split(".").map(Number);
  const bparts = bcore.split(".").map(Number);

  for (let i = 0; i < Math.max(aparts.length, bparts.length); i++) {
    const av = aparts[i] ?? 0;
    const bv = bparts[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }

  if (apre && !bpre) return -1;
  if (!apre && bpre) return 1;
  if (!apre && !bpre) return 0;

  const apreParts = apre!.split(".");
  const bpreParts = bpre!.split(".");
  for (let i = 0; i < Math.max(apreParts.length, bpreParts.length); i++) {
    const av = apreParts[i];
    const bv = bpreParts[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const avNum = Number(av);
    const bvNum = Number(bv);
    const bothNumeric = !Number.isNaN(avNum) && !Number.isNaN(bvNum);
    if (bothNumeric) {
      if (avNum > bvNum) return 1;
      if (avNum < bvNum) return -1;
      continue;
    }
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

vi.mock("semver", () => ({
  default: {
    compare: compareVersions,
  },
}));

const { ConnectorRegistry } = await import("../../src/core/ConnectorRegistry.js");

describe("ConnectorRegistry", () => {
  it("initializes connectors using registered factories and builders", async () => {
    const registry = new ConnectorRegistry();
    const spi = { test: vi.fn() };
    const validate = vi.fn(async () => undefined);
    const builder = vi.fn(async () => ({ validate }));
    const factory = vi.fn(async (config: any) => {
      expect(config).toMatchObject({
        instanceId: "alpha",
        connectorId: "example",
        connectorVersion: "1.0.0",
        type: "example",
      });
      return spi as any;
    });

    registry.registerFactory("example", "1.0.0", factory);
    registry.registerConfigBuilder("example", "1.0.0", builder);

    const instance = await registry.initInstance("alpha", "example", "1.0.0", { foo: "bar" } as any);

    expect(builder).toHaveBeenCalledWith({ foo: "bar" });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(instance.impl).toBe(spi);
    expect(registry.get("alpha")).toBe(instance);
    expect(registry.has("alpha")).toBe(true);
    expect(Array.from(registry.keys())).toEqual(["alpha"]);
    expect(registry.ids()).toEqual(["alpha"]);
    expect(registry.list()).toEqual([instance]);
  });

  it("sorts registered versions using semantic version precedence", () => {
    const registry = new ConnectorRegistry();
    const factory = vi.fn(async () => ({}) as any);

    registry.registerFactory("example", "1.0.0", factory);
    registry.registerFactory("example", "1.0.0-beta.1", factory);
    registry.registerFactory("example", "2.0.0", factory);
    registry.registerFactory("example", "1.10.0", factory);

    expect(registry.getVersions("example")).toEqual([
      "1.0.0-beta.1",
      "1.0.0",
      "1.10.0",
      "2.0.0",
    ]);
    expect(registry.getLatestVersion("example")).toBe("2.0.0");
  });
});
