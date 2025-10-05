import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorRegistry, ConnectorInstance } from "../../src/core/ConnectorRegistry.js";

vi.mock("semver", () => ({
  compare: (a: string, b: string) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const av = pa[i] ?? 0;
      const bv = pb[i] ?? 0;
      if (av > bv) return 1;
      if (av < bv) return -1;
    }
    return 0;
  },
}));

const { buildRouter } = await import("../../src/server/routes.js");

type SpiOverrides = Partial<ConnectorInstance["impl"]>;
type RegistryOverrides = Record<string, any>;

function createApp(spiOverrides: SpiOverrides = {}, registryOverrides: RegistryOverrides = {}) {
  const spi = {
    schema: vi.fn(async () => ({ objects: [] })),
    test: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    sync: vi.fn(async () => ({ token: null })),
    create: vi.fn(async () => ({ uid: "1" })),
    get: vi.fn(async () => ({ uid: "1" })),
    update: vi.fn(async () => ({ uid: "1" })),
    delete: vi.fn(async () => undefined),
    addAttributeValues: vi.fn(async () => ({ uid: "1" })),
    removeAttributeValues: vi.fn(async () => ({ uid: "1" })),
    ...spiOverrides,
  } as ConnectorInstance["impl"];

  const instance = {
    id: "alpha",
    type: "example",
    connectorKey: { type: "example", version: "1.0.0" },
    config: {},
    impl: spi,
  } as ConnectorInstance;

  const registry = {
    get: vi.fn(() => instance),
    has: vi.fn(() => true),
    ids: vi.fn(() => ["alpha"]),
    keys: vi.fn(() => ["alpha"][Symbol.iterator]()),
    list: vi.fn(() => [instance]),
    ...registryOverrides,
  } as unknown as ConnectorRegistry;

  const app = express();
  app.use(express.json());
  app.use("/", buildRouter(registry));

  return { app, spi, registry, instance };
}

describe("router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("objectClass validation", () => {
    it("rejects objectClass values longer than 128 characters", async () => {
      const { app } = createApp();
      const longObjectClass = "a".repeat(129);

      const res = await request(app)
        .post(`/connectors/example/${longObjectClass}/_search`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Invalid objectClass" });
    });
  });

  describe("introspection", () => {
    it("returns the list of connector ids", async () => {
      const { app } = createApp({}, { ids: vi.fn(() => ["alpha", "beta"]) });

      const res = await request(app).get("/connectors");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ids: ["alpha", "beta"] });
    });

    it("returns connector metadata when loaded", async () => {
      const { app, registry, instance } = createApp();

      const res = await request(app).get(`/connectors/${instance.id}`);

      expect(registry.get).toHaveBeenCalledWith(instance.id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: instance.id,
        type: instance.connectorKey.type,
        version: instance.connectorKey.version,
        loaded: true,
      });
    });

    it("returns 404 when connector metadata lookup fails", async () => {
      const error = new Error("Connector missing");
      const { app } = createApp({}, {
        get: vi.fn(() => {
          throw error;
        }),
      });

      const res = await request(app).get("/connectors/missing");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Connector missing" });
    });

  });

  describe("schema & test", () => {
    it("returns 404 when schema SPI is missing", async () => {
      const { app } = createApp({}, { has: vi.fn(() => false) });

      const res = await request(app).get("/connectors/alpha/_schema");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Connector not found" });
    });

    it("returns 501 when schema op is not implemented", async () => {
      const { app } = createApp({ schema: undefined });

      const res = await request(app).get("/connectors/alpha/_schema");

      expect(res.status).toBe(501);
      expect(res.body).toEqual({ error: "Schema not implemented" });
    });

    it("returns schema JSON when successful", async () => {
      const schema = { objectClasses: ["__ACCOUNT__"] };
      const { app, spi } = createApp({ schema: vi.fn(async () => schema) });

      const res = await request(app).get("/connectors/alpha/_schema");

      expect(spi.schema).toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body).toEqual(schema);
    });

    it("returns 204 when test op succeeds", async () => {
      const { app } = createApp({ test: vi.fn(async () => undefined) });

      const res = await request(app).post("/connectors/alpha/_test");

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
    });

    it("returns 500 when test op throws", async () => {
      const { app } = createApp({ test: vi.fn(async () => { throw new Error("boom"); }) });

      const res = await request(app).post("/connectors/alpha/_test");

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "boom" });
    });
  });

  describe("search & sync", () => {
    it("returns 404 when connector is missing", async () => {
      const { app } = createApp({}, {
        has: vi.fn(() => false),
      });

      const res = await request(app)
        .post("/connectors/alpha/__ACCOUNT__/_search")
        .send({});

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Connector not found" });
    });

    it("returns 501 when search op not implemented", async () => {
      const { app } = createApp({ search: undefined });

      const res = await request(app)
        .post("/connectors/alpha/__ACCOUNT__/_search")
        .send({});

      expect(res.status).toBe(501);
      expect(res.body).toEqual({ error: "Search not implemented" });
    });

    it("returns search results when successful", async () => {
      const { app, spi } = createApp({ search: vi.fn(async () => [{ uid: "123" }]) });

      const res = await request(app)
        .post("/connectors/alpha/__ACCOUNT__/_search")
        .send({ filter: { eq: "id" }, options: { pageSize: 10 } });

      expect(spi.search).toHaveBeenCalledWith("__ACCOUNT__", { eq: "id" }, { pageSize: 10 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ uid: "123" }]);
    });

    it("uses null filter and undefined options when omitted", async () => {
      const { app, spi } = createApp({ search: vi.fn(async () => []) });

      await request(app)
        .post("/connectors/alpha/__ACCOUNT__/_search")
        .send({});

      expect(spi.search).toHaveBeenCalledWith("__ACCOUNT__", null, undefined);
    });

    it("returns 400 when search body fails validation", async () => {
      const { app } = createApp();

      const res = await request(app)
        .post("/connectors/alpha/__ACCOUNT__/_search")
        .send({ options: { pageSize: -1 } });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pageSize/);
    });

    it("returns sync results when implemented", async () => {
      const { app, spi } = createApp({ sync: vi.fn(async () => ({ token: "abc" })) });

      const res = await request(app)
        .post("/connectors/alpha/__ACCOUNT__/_sync")
        .send({ token: "t", options: { allowPartialResults: true } });

      expect(spi.sync).toHaveBeenCalledWith("__ACCOUNT__", "t", { allowPartialResults: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ token: "abc" });
    });
  });

  describe("CRUD operations", () => {
    it("creates resources", async () => {
      const { app, spi } = createApp({ create: vi.fn(async () => ({ uid: "new" })) });

      const res = await request(app)
        .post("/connectors/alpha/__ACCOUNT__")
        .send({ attrs: { name: "Alice" } });

      expect(spi.create).toHaveBeenCalledWith("__ACCOUNT__", { name: "Alice" }, undefined);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ uid: "new" });
    });

    it("gets resources and passes query parameters as options", async () => {
      const { app, spi } = createApp({ get: vi.fn(async () => ({ uid: "abc" })) });

      const res = await request(app)
        .get("/connectors/alpha/__ACCOUNT__/123")
        .query({ attributesToGet: ["name"], pageSize: 5 });

      expect(spi.get).toHaveBeenCalledWith(
        "__ACCOUNT__",
        "123",
        expect.objectContaining({ attributesToGet: "name", pageSize: "5" })
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ uid: "abc" });
    });

    it("updates resources", async () => {
      const { app, spi } = createApp({ update: vi.fn(async () => ({ uid: "updated" })) });

      const res = await request(app)
        .patch("/connectors/alpha/__ACCOUNT__/123")
        .send({ attrs: { active: true } });

      expect(spi.update).toHaveBeenCalledWith("__ACCOUNT__", "123", { active: true }, undefined);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ uid: "updated" });
    });

    it("deletes resources", async () => {
      const { app, spi } = createApp({ delete: vi.fn(async () => undefined) });

      const res = await request(app)
        .delete("/connectors/alpha/__ACCOUNT__/123")
        .query({ allowPartialResults: true });

      expect(spi.delete).toHaveBeenCalledWith("__ACCOUNT__", "123", { allowPartialResults: "true" });
      expect(res.status).toBe(204);
    });
  });

  describe("UpdateAttributeValues operations", () => {
    it("adds attribute values", async () => {
      const { app, spi } = createApp({ addAttributeValues: vi.fn(async () => ({ status: "ok" })) });

      const res = await request(app)
        .post("/connectors/alpha/__ACCOUNT__/123/_addAttributeValues")
        .send({ attrs: { groups: ["admin"] } });

      expect(spi.addAttributeValues).toHaveBeenCalledWith("__ACCOUNT__", "123", { groups: ["admin"] }, undefined);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });

    it("removes attribute values", async () => {
      const { app, spi } = createApp({ removeAttributeValues: vi.fn(async () => ({ status: "ok" })) });

      const res = await request(app)
        .post("/connectors/alpha/__ACCOUNT__/123/_removeAttributeValues")
        .send({ attrs: { groups: ["admin"] } });

      expect(spi.removeAttributeValues).toHaveBeenCalledWith("__ACCOUNT__", "123", { groups: ["admin"] }, undefined);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });
  });
});
