import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import http from "node:http";
import express from "express";
import request from "supertest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { JwtConfig } from "../src/security/auth.js";

const ISS = "https://issuer.test";
const AUD = "test-aud";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
Object.assign(jwk, { kid: "test-key", alg: "RS256", use: "sig" });

const jwksServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
const { port } = jwksServer.address() as { port: number };

process.env.JWT_JWKS_URI = `http://127.0.0.1:${port}/jwks.json`;
process.env.JWT_EXPECTED_ISS = ISS;
process.env.JWT_EXPECTED_AUD = AUD;
// Small age so an "old" token can be produced without waiting.
process.env.JWT_MAX_TOKEN_AGE_SEC = "60";

const { requireJwt, validateJwtConfig } = await import("../src/security/auth.js");

const baseEnv = { ...process.env };

afterAll(() => jwksServer.close());

describe("JWT_MAX_TOKEN_AGE_SEC validation", () => {
    beforeEach(() => {
        process.env.JWT_JWKS_URI = baseEnv.JWT_JWKS_URI;
        process.env.JWT_EXPECTED_ISS = ISS;
        process.env.JWT_EXPECTED_AUD = AUD;
    });

    afterEach(() => {
        process.env = { ...baseEnv };
    });

    it("defaults to 86400 when unset", () => {
        delete process.env.JWT_MAX_TOKEN_AGE_SEC;
        const config: JwtConfig = validateJwtConfig();
        expect(config.maxTokenAgeSeconds).toBe(86400);
    });

    it("accepts a valid explicit value", () => {
        process.env.JWT_MAX_TOKEN_AGE_SEC = "300";
        expect(validateJwtConfig().maxTokenAgeSeconds).toBe(300);
    });

    it("rejects a non-integer", () => {
        process.env.JWT_MAX_TOKEN_AGE_SEC = "abc";
        expect(() => validateJwtConfig()).toThrow(/JWT_MAX_TOKEN_AGE_SEC must be an integer/);
    });

    it("rejects zero and negatives", () => {
        process.env.JWT_MAX_TOKEN_AGE_SEC = "0";
        expect(() => validateJwtConfig()).toThrow(/JWT_MAX_TOKEN_AGE_SEC must be positive/);
        process.env.JWT_MAX_TOKEN_AGE_SEC = "-5";
        expect(() => validateJwtConfig()).toThrow(/JWT_MAX_TOKEN_AGE_SEC must be positive/);
    });

    it("rejects values above the seven-day ceiling", () => {
        process.env.JWT_MAX_TOKEN_AGE_SEC = String(7 * 24 * 60 * 60 + 1);
        expect(() => validateJwtConfig()).toThrow(/JWT_MAX_TOKEN_AGE_SEC is too large/);
    });
});

describe("max token age enforcement", () => {
    async function sign(iatOffsetSec: number) {
        const iat = Math.floor(Date.now() / 1000) + iatOffsetSec;
        return new SignJWT({ scope: "read" })
            .setProtectedHeader({ alg: "RS256", kid: "test-key" })
            .setSubject("user-1")
            .setIssuer(ISS)
            .setAudience(AUD)
            .setIssuedAt(iat)
            .setExpirationTime("2h")
            .sign(privateKey);
    }

    function app() {
        const a = express();
        a.use(requireJwt());
        a.get("/protected", (_req, res) => res.json({ ok: true }));
        return a;
    }

    it("accepts a token younger than the configured age", async () => {
        const res = await request(app()).get("/protected")
            .set({ Authorization: `Bearer ${await sign(-5)}` });
        expect(res.status).toBe(200);
    });

    it("rejects a token older than the configured age", async () => {
        // Configured age is 60s; this token was issued 10 minutes ago but does
        // not expire for another 2 hours, so only maxTokenAge rejects it.
        const res = await request(app()).get("/protected")
            .set({ Authorization: `Bearer ${await sign(-600)}` });
        expect(res.status).toBe(401);
    });
});
