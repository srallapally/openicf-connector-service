import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import express from "express";
import request from "supertest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const ISS = "https://issuer.test";
const AUD = "test-aud";

// Real signing keys plus a local JWKS endpoint, so verification runs for real
// rather than against a mocked jose.
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
Object.assign(jwk, { kid: "test-key", alg: "RS256", use: "sig" });

// A second, unrelated key: tokens signed with it must fail signature checks.
const other = await generateKeyPair("RS256");

const jwksServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
const { port } = jwksServer.address() as { port: number };

process.env.JWT_JWKS_URI = `http://127.0.0.1:${port}/jwks.json`;
process.env.JWT_EXPECTED_ISS = ISS;
process.env.JWT_EXPECTED_AUD = AUD;
// Deliberately set: under the old model this disabled the JTI requirement and
// engaged the fallback identifier. Under bearer semantics it is ignored
// entirely, and startup must still succeed.
process.env.JWT_REQUIRE_JTI = "false";

const { requireJwt } = await import("../src/security/auth.js");

type SignOpts = {
    sub?: string;
    jti?: string;
    iat?: number;
    scope?: string;
    iss?: string;
    aud?: string;
    expiresIn?: string;
    key?: CryptoKey | Uint8Array;
    filler?: string;
};

async function sign(opts: SignOpts = {}) {
    const iat = opts.iat ?? Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = { scope: opts.scope ?? "read write" };
    if (opts.jti) payload.jti = opts.jti;
    if (opts.filler) payload.filler = opts.filler;

    return new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setSubject(opts.sub ?? "user-1")
        .setIssuer(opts.iss ?? ISS)
        .setAudience(opts.aud ?? AUD)
        .setIssuedAt(iat)
        .setExpirationTime(opts.expiresIn ?? "5m")
        .sign((opts.key ?? privateKey) as any);
}

function appWith(scopes?: string | string[]) {
    const app = express();
    app.use(requireJwt(scopes));
    app.get("/protected", (_req, res) => res.json({ ok: true }));
    return app;
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

afterAll(() => {
    jwksServer.close();
});

describe("standard bearer semantics", () => {
    it("accepts the same token on two consecutive requests", async () => {
        const token = await sign({ jti: "jti-reuse-1" });
        const app = appWith();

        const first = await request(app).get("/protected").set(bearer(token));
        const second = await request(app).get("/protected").set(bearer(token));

        // Under the replay model the second request was 401 "Replay detected".
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
    });

    it("accepts two distinct tokens sharing sub, iat and aud", async () => {
        const iat = Math.floor(Date.now() / 1000);
        const a = await sign({ sub: "same-sub", iat, filler: "a" });
        const b = await sign({ sub: "same-sub", iat, filler: "b" });
        expect(a).not.toBe(b);

        const app = appWith();
        const first = await request(app).get("/protected").set(bearer(a));
        const second = await request(app).get("/protected").set(bearer(b));

        // These collided under the fallback identifier sha256(sub|iat|aud), so
        // the second legitimate token was rejected as a replay.
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
    });

    it("accepts a token with no jti claim", async () => {
        const app = appWith();
        const res = await request(app).get("/protected").set(bearer(await sign()));
        expect(res.status).toBe(200);
    });

    it("ignores JWT_REQUIRE_JTI and still starts", async () => {
        // The var is set to "false" at module load above. Under bearer
        // semantics it is neither validated nor consulted; startup succeeded,
        // proven by this suite having imported the module at all.
        expect(process.env.JWT_REQUIRE_JTI).toBe("false");
        const res = await request(appWith()).get("/protected").set(bearer(await sign()));
        expect(res.status).toBe(200);
    });
});

describe("verification checks retained", () => {
    it("rejects an expired token", async () => {
        const token = await sign({ expiresIn: "-1m" });
        const res = await request(appWith()).get("/protected").set(bearer(token));
        expect(res.status).toBe(401);
        expect(res.body.error).toBe("Token expired");
    });

    it("rejects a bad signature", async () => {
        const token = await sign({ key: other.privateKey });
        const res = await request(appWith()).get("/protected").set(bearer(token));
        expect(res.status).toBe(401);
    });

    it("rejects a wrong audience", async () => {
        const token = await sign({ aud: "someone-else" });
        const res = await request(appWith()).get("/protected").set(bearer(token));
        expect(res.status).toBe(401);
    });

    it("rejects a wrong issuer", async () => {
        const token = await sign({ iss: "https://evil.test" });
        const res = await request(appWith()).get("/protected").set(bearer(token));
        expect(res.status).toBe(401);
    });

    it("rejects a missing bearer token", async () => {
        const res = await request(appWith()).get("/protected");
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: "Missing bearer token" });
    });

    it("enforces required scopes", async () => {
        const token = await sign({ scope: "read" });
        const res = await request(appWith("admin")).get("/protected").set(bearer(token));
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: "Insufficient scope" });
    });

    it("allows a token that carries the required scope", async () => {
        const token = await sign({ scope: "read admin" });
        const res = await request(appWith("admin")).get("/protected").set(bearer(token));
        expect(res.status).toBe(200);
    });
});
