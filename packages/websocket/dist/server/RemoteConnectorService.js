import WebSocket from "ws";
import { ConnectorRegistry, ConnectorFacade } from '@openicf/connector-core';
import { RateLimiter } from '@openicf/connector-core/infra';
import { loadCsrfConfig, validateWebSocketOrigin } from "../security/csrf.js";
import { OAuthTokenProvider } from "./OAuthTokenProvider.js";
import { loadExternalConnectors } from "@openicf/connector-core/loader";
export class RemoteConnectorService {
    opts;
    ws = null;
    reconnectDelayMs;
    reconnectInitialDelayMs;
    reconnectMaxDelayMs;
    reconnectHandle = null;
    startedAt = new Date().toISOString();
    shuttingDown = false;
    facades = new Map();
    // Token expiry tracking for security
    connectionEstablishedAt = 0;
    currentTokenExpiresAt = 0;
    tokenCheckInterval = null;
    TOKEN_CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds
    TOKEN_REFRESH_BUFFER_MS = 5 * 60_000; // Refresh 5 min before expiry
    // Security: Rate limiter for WebSocket messages to prevent abuse
    // Matches HTTP rate limiting: 300 req/min = 5 tokens/sec, burst capacity of 20
    rateLimiter = new RateLimiter(20, 5);
    constructor(opts) {
        this.opts = opts;
        this.reconnectInitialDelayMs = opts.reconnectInitialDelayMs ?? 1_000;
        this.reconnectMaxDelayMs = opts.reconnectMaxDelayMs ?? 30_000;
        this.reconnectDelayMs = this.reconnectInitialDelayMs;
    }
    async start() {
        this.populateFacades();
        await this.openConnection();
    }
    async shutdown() {
        this.shuttingDown = true;
        this.stopTokenValidationCheck();
        if (this.reconnectHandle) {
            clearTimeout(this.reconnectHandle);
            this.reconnectHandle = null;
        }
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close(1000, "shutdown");
        }
    }
    populateFacades() {
        for (const inst of this.opts.registry.list()) {
            this.facades.set(inst.id, new ConnectorFacade(inst.impl));
        }
    }
    listConnectors() {
        return this.opts.registry.ids();
    }
    getFacade(id) {
        let facade = this.facades.get(id);
        if (!facade) {
            const inst = this.opts.registry.get(id);
            facade = new ConnectorFacade(inst.impl);
            this.facades.set(id, facade);
        }
        return facade;
    }
    /**
     * Start periodic token validation checks
     * Security: Prevents expired/revoked tokens from remaining active
     */
    startTokenValidationCheck() {
        this.stopTokenValidationCheck(); // Clear any existing interval
        this.tokenCheckInterval = setInterval(() => {
            this.checkTokenExpiry();
        }, this.TOKEN_CHECK_INTERVAL_MS);
        // Unref so it doesn't prevent process exit
        this.tokenCheckInterval.unref();
    }
    /**
     * Stop token validation checks
     */
    stopTokenValidationCheck() {
        if (this.tokenCheckInterval) {
            clearInterval(this.tokenCheckInterval);
            this.tokenCheckInterval = null;
        }
    }
    /**
     * Check if current token is expired or about to expire
     * Proactively reconnect with fresh token before expiry
     */
    checkTokenExpiry() {
        if (this.shuttingDown)
            return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        const now = Date.now();
        // Check if token has already expired
        if (now >= this.currentTokenExpiresAt) {
            console.warn(`[ws-auth] Token expired, disconnecting for security`);
            this.ws.close(1008, "token-expired");
            this.stopTokenValidationCheck();
            this.scheduleReconnect();
            return;
        }
        // Check if token is about to expire (within buffer window)
        const timeUntilExpiry = this.currentTokenExpiresAt - now;
        if (timeUntilExpiry <= this.TOKEN_REFRESH_BUFFER_MS) {
            console.log(`[ws-auth] Token expiring in ${Math.floor(timeUntilExpiry / 1000)}s, proactively reconnecting`);
            this.ws.close(1000, "token-refresh");
            this.stopTokenValidationCheck();
            this.scheduleReconnect();
        }
    }
    async openConnection() {
        if (this.shuttingDown)
            return;
        try {
            const token = await this.opts.oauth.getToken();
            const tokenExpiresAt = this.opts.oauth.getTokenExpiryTime();
            this.establishWebSocket(token, tokenExpiresAt);
        }
        catch (err) {
            console.error(`[ws] failed to get token or connect: ${err.message}`);
            this.scheduleReconnect();
        }
    }
    establishWebSocket(token, tokenExpiresAt) {
        // CSRF Protection Enhancement: Load CSRF config for WebSocket Origin validation
        const csrfConfig = loadCsrfConfig();
        const ws = new WebSocket(this.opts.serverUrl, {
            headers: { Authorization: `Bearer ${token}` },
        });
        this.ws = ws;
        ws.on("open", () => {
            console.log(`[ws] connected to ${this.opts.serverUrl}`);
            this.reconnectDelayMs = this.reconnectInitialDelayMs;
            // Track token expiry for security
            this.connectionEstablishedAt = Date.now();
            this.currentTokenExpiresAt = tokenExpiresAt;
            const expiresInSec = Math.floor((tokenExpiresAt - Date.now()) / 1000);
            console.log(`[ws-auth] Connection established with token expiring in ${expiresInSec}s`);
            // Start periodic token validation
            this.startTokenValidationCheck();
            this.sendServiceInfo();
        });
        ws.on("message", (data) => this.handleMessage(data));
        ws.on("ping", (data) => {
            if (ws.readyState === WebSocket.OPEN)
                ws.pong(data);
        });
        ws.on("close", (code, reason) => {
            const readableReason = reason.toString("utf8");
            console.warn(`[ws] connection closed (${code}) ${readableReason}`);
            this.ws = null;
            this.stopTokenValidationCheck(); // Stop token checks when connection closes
            if (!this.shuttingDown)
                this.scheduleReconnect();
        });
        ws.on("error", (err) => {
            console.error(`[ws] error: ${err.message}`);
            if (ws.readyState === WebSocket.CLOSED)
                this.scheduleReconnect();
        });
        ws.on("unexpected-response", (req, res) => {
            console.error(`[ws] unexpected response: ${res.statusCode}`);
            // CSRF Protection Enhancement: Validate Origin header during WebSocket handshake
            // This prevents cross-origin WebSocket connections from malicious sites
            const originHeader = req.headers.origin;
            const hostHeader = req.headers.host;
            if (!validateWebSocketOrigin(originHeader, csrfConfig, hostHeader)) {
                console.error(`[ws-csrf] WebSocket connection rejected due to invalid origin: ` +
                    `origin=${originHeader}, host=${hostHeader}`);
                res.resume();
                ws.close();
                if (!this.shuttingDown)
                    this.scheduleReconnect();
                return;
            }
            if (res.statusCode === 401 || res.statusCode === 403)
                this.opts.oauth.invalidate();
            res.resume();
            ws.close();
            if (!this.shuttingDown)
                this.scheduleReconnect();
        });
    }
    scheduleReconnect() {
        if (this.shuttingDown)
            return;
        if (this.reconnectHandle)
            return;
        const delayMs = this.reconnectDelayMs;
        console.log(`[ws] reconnecting in ${delayMs}ms`);
        this.reconnectHandle = setTimeout(async () => {
            this.reconnectHandle = null;
            this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaxDelayMs);
            await this.openConnection();
        }, delayMs);
    }
    send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
    sendServiceInfo() {
        this.send({
            type: "service-info",
            service: "openicf-connector-service",
            startedAt: this.startedAt,
            connectors: this.listConnectors(),
        });
    }
    async handleMessage(raw) {
        let parsed;
        try {
            parsed = JSON.parse(raw.toString());
        }
        catch {
            console.warn("[ws] received invalid JSON payload");
            return;
        }
        const type = typeof parsed === "object" && parsed ? parsed.type : undefined;
        if (typeof type !== "string") {
            console.warn("[ws] message missing type");
            return;
        }
        const requestId = typeof parsed.requestId === "string" ? parsed.requestId : undefined;
        // Security: Apply rate limiting to prevent abuse
        // Different message types have different costs:
        // - ping, list-connectors: 0.5 tokens (lightweight, informational)
        // - operation: 1 token (expensive, performs actual work)
        let messageCost = 1; // Default cost for unknown/operation messages
        if (type === "ping" || type === "list-connectors") {
            messageCost = 0.5; // Lightweight operations
        }
        // Security: Check rate limit before processing message
        if (!this.rateLimiter.tryConsume(messageCost)) {
            const violations = this.rateLimiter.getViolationCount();
            console.warn(`[ws-rate-limit] Message rate limit exceeded (type: ${type}, violations: ${violations})`);
            // Send error response to client instead of silently dropping
            if (requestId) {
                this.send({
                    type: "error",
                    requestId,
                    error: "Rate limit exceeded. Please slow down your requests.",
                    code: "RATE_LIMIT_EXCEEDED",
                });
            }
            return;
        }
        switch (type) {
            case "ping": {
                this.send({ type: "pong", requestId, timestamp: new Date().toISOString(), connectors: this.listConnectors() });
                break;
            }
            case "list-connectors": {
                this.send({ type: "connectors", requestId, connectors: this.listConnectors() });
                break;
            }
            case "operation": {
                if (!requestId) {
                    console.warn("[ws] operation request missing requestId");
                    return;
                }
                this.handleOperation(parsed, requestId).catch((err) => {
                    console.error(`[ws] operation handler failed: ${err.message}`);
                });
                break;
            }
            default:
                console.warn(`[ws] unknown message type: ${type}`);
                if (requestId) {
                    this.send({ type: "error", requestId, error: `Unknown message type: ${type}` });
                }
        }
    }
    async handleOperation(msg, requestId) {
        try {
            const result = await this.performOperation(msg);
            this.send({ type: "response", requestId, success: true, result });
        }
        catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.send({
                type: "response",
                requestId,
                success: false,
                error: {
                    message: error.message,
                    name: error.name,
                },
            });
        }
    }
    sanitizeOptions(o) {
        if (!o || typeof o !== "object" || Array.isArray(o))
            return undefined;
        const out = {};
        for (const [k, v] of Object.entries(o)) {
            if (v !== undefined)
                out[k] = v;
        }
        return out;
    }
    expectString(value, message) {
        if (typeof value !== "string" || !value)
            throw new Error(message);
        return value;
    }
    expectRecord(value, message) {
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error(message);
        return value;
    }
    async performOperation(msg) {
        const facade = this.getFacade(msg.connectorId);
        const payload = (msg.payload ?? {});
        switch (msg.operation) {
            case "schema":
                return await facade.schema();
            case "test":
                await facade.test();
                return null;
            case "create": {
                const objectClass = this.expectString(payload.objectClass, "objectClass is required");
                const attrs = this.expectRecord(payload.attrs, "attrs is required");
                const options = this.sanitizeOptions(payload.options);
                return await facade.create(objectClass, attrs, options);
            }
            case "get": {
                const objectClass = this.expectString(payload.objectClass, "objectClass is required");
                const uid = this.expectString(payload.uid, "uid is required");
                const options = this.sanitizeOptions(payload.options);
                return await facade.get(objectClass, uid, options);
            }
            case "update": {
                const objectClass = this.expectString(payload.objectClass, "objectClass is required");
                const uid = this.expectString(payload.uid, "uid is required");
                const attrs = this.expectRecord(payload.attrs, "attrs is required");
                const options = this.sanitizeOptions(payload.options);
                return await facade.update(objectClass, uid, attrs, options);
            }
            case "delete": {
                const objectClass = this.expectString(payload.objectClass, "objectClass is required");
                const uid = this.expectString(payload.uid, "uid is required");
                const options = this.sanitizeOptions(payload.options);
                await facade.delete(objectClass, uid, options);
                return null;
            }
            case "search": {
                const objectClass = this.expectString(payload.objectClass, "objectClass is required");
                const filter = payload.filter ?? null;
                const options = this.sanitizeOptions(payload.options);
                return await facade.search(objectClass, filter, options);
            }
            case "sync": {
                const objectClass = this.expectString(payload.objectClass, "objectClass is required");
                const token = payload.token ?? null;
                const options = this.sanitizeOptions(payload.options);
                return await facade.sync(objectClass, token, options);
            }
            case "addAttributeValues": {
                const objectClass = this.expectString(payload.objectClass, "objectClass is required");
                const uid = this.expectString(payload.uid, "uid is required");
                const attrs = this.expectRecord(payload.attrs, "attrs is required");
                const options = this.sanitizeOptions(payload.options);
                return await facade.addAttributeValues(objectClass, uid, attrs, options);
            }
            case "removeAttributeValues": {
                const objectClass = this.expectString(payload.objectClass, "objectClass is required");
                const uid = this.expectString(payload.uid, "uid is required");
                const attrs = this.expectRecord(payload.attrs, "attrs is required");
                const options = this.sanitizeOptions(payload.options);
                return await facade.removeAttributeValues(objectClass, uid, attrs, options);
            }
            case "scriptOnConnector": {
                const ctx = this.expectRecord(payload.context, "context is required");
                const language = this.expectString(ctx.language, "context.language is required");
                const script = this.expectString(ctx.script, "context.script is required");
                const paramsValue = ctx.params;
                let params;
                if (paramsValue && typeof paramsValue === "object" && !Array.isArray(paramsValue)) {
                    params = paramsValue;
                }
                const scriptCtx = { language, script };
                if (params)
                    scriptCtx.params = params;
                return await facade.scriptOnConnector(scriptCtx);
            }
            default:
                throw new Error(`Unsupported operation: ${msg.operation}`);
        }
    }
}
function getArgValue(argv, name) {
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === name) {
            return i + 1 < argv.length ? argv[i + 1] : undefined;
        }
        if (arg && arg.startsWith(`${name}=`)) {
            return arg.slice(name.length + 1);
        }
    }
    return undefined;
}
async function main() {
    const serverUrl = process.env.REMOTE_CONNECTOR_WS_URL;
    const tokenUrl = process.env.OAUTH_TOKEN_URL;
    const clientId = process.env.OAUTH_CLIENT_ID;
    const clientSecret = process.env.OAUTH_CLIENT_SECRET;
    if (!serverUrl)
        throw new Error("REMOTE_CONNECTOR_WS_URL must be set");
    if (!tokenUrl)
        throw new Error("OAUTH_TOKEN_URL must be set");
    if (!clientId)
        throw new Error("OAUTH_CLIENT_ID must be set");
    if (!clientSecret)
        throw new Error("OAUTH_CLIENT_SECRET must be set");
    const oauth = new OAuthTokenProvider({
        tokenUrl,
        clientId,
        clientSecret,
        scope: process.env.OAUTH_SCOPE,
        audience: process.env.OAUTH_AUDIENCE,
        resource: process.env.OAUTH_RESOURCE,
    });
    const registry = new ConnectorRegistry();
    const argv = process.argv.slice(2);
    const connectorsDir = getArgValue(argv, "--connectors") ?? process.env.CONNECTORS_DIR;
    if (connectorsDir) {
        console.log(`Loading external connectors from: ${connectorsDir}`);
        await loadExternalConnectors(connectorsDir, registry);
    }
    else {
        console.log("No external connectors directory provided. Use --connectors <dir> or CONNECTORS_DIR env.");
    }
    const service = new RemoteConnectorService({ serverUrl, registry, oauth });
    await service.start();
    const shutdown = async () => {
        console.log("Shutting down remote connector service");
        await service.shutdown();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=RemoteConnectorService.js.map