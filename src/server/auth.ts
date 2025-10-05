import { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, JWTPayload, errors as JoseErrors } from "jose";
import { URL } from "url";

class JtiCache {
  private map = new Map<string, number>();
  constructor(private sweepMs = 60_000) { setInterval(() => this.sweep(), sweepMs).unref(); }
  has(jti: string) { return this.map.has(jti); }
  put(jti: string, expEpochSec: number) { this.map.set(jti, expEpochSec); }
  private sweep() {
    const now = Math.floor(Date.now()/1000);
    for (const [j, exp] of this.map.entries()) if (exp <= now) this.map.delete(j);
  }
  claim(jti: string, expEpochSec: number): boolean {
        this.sweep();
        const current = this.map.get(jti);
        if (current && current > Math.floor(Date.now() / 1000)) return false;
        this.map.set(jti, expEpochSec);
        return true;
  }
}
const jtiCache = new JtiCache();

const JWKS_URI = process.env.JWT_JWKS_URI!;
const EXPECTED_ISS = process.env.JWT_EXPECTED_ISS!;
const EXPECTED_AUD = process.env.JWT_EXPECTED_AUD!;
const ALGS = (process.env.JWT_ALLOWED_ALGS || "RS256,PS256,ES256").split(",").map(s => s.trim());
const SKEW = Number(process.env.JWT_ACCEPTED_CLOCK_SKEW_SEC || "60");
const REQUIRED_SCOPE = process.env.JWT_REQUIRED_SCOPE;

if (!JWKS_URI || !EXPECTED_ISS || !EXPECTED_AUD) {
  throw new Error("JWT_JWKS_URI, JWT_EXPECTED_ISS, JWT_EXPECTED_AUD must be set");
}

const jwks = createRemoteJWKSet(new URL(JWKS_URI), {
  // v5 options:
  timeoutDuration: 5_000,         // how long to wait for the JWKS fetch
  cooldownDuration: 10 * 60_000,  // how long to reuse a valid JWKS before re-fetch heuristics
  // agent / headers / fetcher are also available if you need them
});
export interface AuthContext {
  sub: string;
  scopes: string[];
  token: string;
  payload: JWTPayload;
}

declare global {
  namespace Express { interface Request { auth?: AuthContext; } }
}

function parseAuthHeader(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [type, val] = h.split(" ");
  if (!type || !val || type.toLowerCase() != "bearer") return null;
  return val.trim();
}

function scopeAllowed(scopes: string[], required?: string | string[]) {
  if (!required) return true;
  const list = Array.isArray(required) ? required : [required];
  return list.every(r => scopes.includes(r));
}

export async function requireJwt(requiredScopes?: string | string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = parseAuthHeader(req);
      if (!token) return res.status(401).json({ error: "Missing bearer token" });

      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        algorithms: ALGS as any,
        issuer: EXPECTED_ISS,
        audience: EXPECTED_AUD,
        maxTokenAge: `${24}h`,
        clockTolerance: SKEW,
      });

      if (!protectedHeader.kid) return res.status(401).json({ error: "Missing kid" });
      if (!ALGS.includes(protectedHeader.alg as string)) return res.status(401).json({ error: "Unsupported alg" });

      const sub = payload.sub;
      const exp = payload.exp;
      if (!sub || !exp) return res.status(401).json({ error: "Missing sub/exp" });

      const jti = payload.jti;
      if (jti) {
          if (jti && !jtiCache.claim(jti, exp)) {
              return res.status(401).json({ error: "Replay detected" });
          }
          jtiCache.put(jti, exp);
      }

      const scopes = Array.isArray((payload as any).scope)
        ? (payload as any).scope
        : String((payload as any).scope || "").split(" ").filter(Boolean);

      if (REQUIRED_SCOPE && !scopeAllowed(scopes, REQUIRED_SCOPE)) return res.status(403).json({ error: "Insufficient scope" });
      if (requiredScopes && !scopeAllowed(scopes, requiredScopes)) return res.status(403).json({ error: "Insufficient scope" });

      req.auth = { sub, scopes, token, payload };
      return next();
    } catch (e: any) {
      if (e instanceof JoseErrors.JWTExpired) return res.status(401).json({ error: "Token expired" });
      if (e instanceof JoseErrors.JWTInvalid) return res.status(401).json({ error: "Invalid token" });
      if (e instanceof JoseErrors.JWSSignatureVerificationFailed) return res.status(401).json({ error: "Bad signature" });
      return res.status(401).json({ error: "Unauthorized" });
    }
  };
}
