import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorRegistry } from "../core/ConnectorRegistry.js";

vi.mock("semver", () => ({ compare: () => 0 }), { virtual: true });

const { buildRouter } = await import("./routes.js");

describe("objectClass validation", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    const registryStub = {
      get: () => ({ impl: {} }),
      has: () => true,
      keys: () => [][Symbol.iterator](),
      ids: () => []
    } as unknown as ConnectorRegistry;

    app.use("/", buildRouter(registryStub));
    return app;
  }

  it("rejects objectClass values longer than 128 characters", async () => {
    const app = makeApp();
    const longObjectClass = "a".repeat(129);

    const res = await request(app)
      .post(`/connectors/example/${longObjectClass}/_search`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid objectClass" });
  });
});
