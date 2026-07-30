import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import type { RequestHandler } from "express";

// Type-only import: erased, so it does not execute auth.ts before env is set.
import type { requireJwt as RequireJwtType } from "../src/security/auth.js";

process.env.JWT_JWKS_URI = "https://example.com/.well-known/jwks.json";
process.env.JWT_EXPECTED_ISS = "https://example.com";
process.env.JWT_EXPECTED_AUD = "test-audience";

const { requireJwt } = await import("../src/security/auth.js");

describe("requireJwt returns middleware, not a Promise", () => {
    it("can be mounted directly with app.use()", async () => {
        const app = express();
        // On the previous implementation requireJwt was `async`, so this
        // mounted a Promise and express rejected it outright.
        app.use(requireJwt());
        app.get("/protected", (_req, res) => res.json({ ok: true }));

        const res = await request(app).get("/protected");

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: "Missing bearer token" });
    });

    it("is assignable to express RequestHandler", () => {
        // Documentation of intent. Note this annotation is NOT enforced by the
        // build: packages/websocket/tsconfig.json excludes **/*.test.ts, so tsc
        // never checks it. The enforced guarantee is the explicit
        // `: RequestHandler` return type on requireJwt itself, in src.
        const handler: RequestHandler = requireJwt();
        expect(typeof handler).toBe("function");
        expect(handler.length).toBeGreaterThanOrEqual(3);
    });

    it("keeps its declared type", () => {
        const typed: typeof RequireJwtType = requireJwt;
        expect(typeof typed).toBe("function");
    });
});
