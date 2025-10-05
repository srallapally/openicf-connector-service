import express from "express";
import { buildRouter } from "./routes.js";
import { securityMiddleware, bodyLimit, requestTimeout } from "./hardening.js";
import { ConnectorRegistry } from "../core/ConnectorRegistry.js";
import { requireJwt } from "./auth.js";
import { loadExternalConnectors } from "../loader/ExternalLoader.js";
function getArgValue(argv, name) {
    // supports: --name value  OR  --name=value
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === undefined)
            continue; // for noUncheckedIndexedAccess
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
    // Trust proxy hardening
    const TP = process.env.TRUST_PROXY;
    if (!TP) {
        app.set("trust proxy", 0); // disable trusting X-Forwarded-For by default
    }
    else if (/^\d+$/.test(TP)) {
        app.set("trust proxy", parseInt(TP, 10));
    }
    else if (TP.includes(",")) {
        app.set("trust proxy", TP.split(",").map(s => s.trim())); // e.g. "127.0.0.1,::1"
    }
    else if (TP === "true" || TP === "false") {
        app.set("trust proxy", TP === "true"); // not recommended: true trusts everyone
    }
    else {
        app.set("trust proxy", TP); // e.g. "loopback", "uniquelocal", or a CIDR
    }
    // Baseline hardening + limits
    app.use(...securityMiddleware);
    app.use(express.json({ limit: "1mb" }));
    app.use(...bodyLimit("512kb"));
    app.use(requestTimeout);
    // Registry
    const registry = new ConnectorRegistry();
    // 🔐 Protect all /connectors/* routes with JWT — mount this BEFORE router
    app.use("/connectors", await requireJwt());
    // Mount router ONCE at root. It contains /connectors routes inside.
    app.use("/", buildRouter(registry));
    // Load external connectors (factories + instances) before mounting routes
    const argv = process.argv.slice(2);
    const connectorsDir = getArgValue(argv, "--connectors") ?? process.env.CONNECTORS_DIR;
    if (connectorsDir) {
        console.log("Loading external connectors from:", connectorsDir);
        await loadExternalConnectors(connectorsDir, registry);
    }
    else {
        console.log("No external connectors directory provided. Use --connectors <dir> or CONNECTORS_DIR env.");
    }
    // Debug: print mounted routes
    printRoutes(app);
    // Error handler LAST
    app.use((err, _req, res, _next) => {
        const message = (typeof err === "object" && err && "message" in err) ? String(err.message) : String(err);
        const code = message.includes("TooManyRequests") ? 429 :
            message.includes("CircuitOpen") ? 503 : 400;
        res.status(code).json({ error: message });
    });
    const port = Number(process.env.PORT ?? 8080);
    app.listen(port, () => console.log(`Connector service listening on :${port}`));
}
function printRoutes(app) {
    const stack = app._router?.stack ?? [];
    console.log("printRoutes");
    for (const l of stack) {
        if (l?.route) {
            const methods = Object.keys(l.route.methods).join(",").toUpperCase();
            console.log(`[route] ${methods} ${l.route.path}`);
        }
        else if (l?.name === "router" && l.handle?.stack) {
            for (const rl of l.handle.stack) {
                if (rl?.route) {
                    const methods = Object.keys(rl.route.methods).join(",").toUpperCase();
                    console.log(`[route] ${methods} ${rl.route.path}`);
                }
            }
        }
    }
    console.log("Exiting printRoutes");
}
main().catch((e) => { console.error(e); process.exit(1); });
