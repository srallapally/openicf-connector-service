import express from "express";
import type { Request, Response, NextFunction } from "express"; // ⬅ add types
import { securityMiddleware, bodyLimit, requestTimeout } from "./hardening.js";
import { ConnectorRegistry } from "../core/ConnectorRegistry.js";
import { buildRouter } from "./routes.js";
import { requireJwt } from "./auth.js";
import { loadExternalConnectors } from "../loader/ExternalLoader.js";

function getArgValue(argv: readonly string[], name: string): string | undefined {
  // supports: --name value  OR  --name=value
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue; // <-- narrow for noUncheckedIndexedAccess

    if (a === name) {
      return i + 1 < argv.length ? argv[i + 1] : undefined; // bounds check
    }
    if (a.startsWith(name + "=")) {
      return a.slice(name.length + 1);
    }
  }
  return undefined;
}

async function main() {
  const app = express();
  app.disable("x-powered-by");
  const TP = process.env.TRUST_PROXY;
  if (!TP) {
    app.set("trust proxy", 0); // ✅ disables trusting X-Forwarded-For
  } else if (/^\d+$/.test(TP)) {
    app.set("trust proxy", parseInt(TP, 10));       // e.g. TRUST_PROXY=1 (single reverse proxy)
  } else if (TP.includes(",")) {
    app.set("trust proxy", TP.split(",").map(s => s.trim())); // e.g. TRUST_PROXY="127.0.0.1,::1"
  } else if (TP === "true" || TP === "false") {
    app.set("trust proxy", TP === "true");          // not recommended: true trusts everyone
  } else {
    app.set("trust proxy", TP);                     // e.g. "loopback", "uniquelocal", CIDR
  }

  app.use(...securityMiddleware);
  app.use(...bodyLimit("512kb"));
  app.use(requestTimeout);

  // 🔐 Require JWT on all connector routes
  app.use("/connectors", await requireJwt());

  const registry = new ConnectorRegistry();

  // External connectors via --connectors or CONNECTORS_DIR env
  const argv = process.argv.slice(2);
  const connectorsDir = getArgValue(argv, "--connectors") ?? process.env.CONNECTORS_DIR;
  if (connectorsDir) {
    console.log("Loading external connectors from:", connectorsDir);
    await loadExternalConnectors(connectorsDir, registry, process.env.CONNECTORS_MANIFEST || "manifest.json");
  } else {
    console.log("No external connectors directory provided. Use --connectors <dir> or CONNECTORS_DIR env.");
  }

  app.use("/connectors", buildRouter(registry));

  // Explicitly type the error middleware params
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message =
        (typeof err === "object" && err && "message" in err) ? String((err as any).message) : String(err);
    const code =
        message.includes("TooManyRequests") ? 429 :
            message.includes("CircuitOpen") ? 503 : 400;
    res.status(code).json({ error: message });
  });

  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => console.log(`Connector service listening on :${port}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
