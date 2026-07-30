import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sockets: FakeWS[] = [];

class FakeWS {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeWS.OPEN;
    handlers = new Map<string, (...args: any[]) => void>();
    closed = false;

    constructor(public url: string, public opts: unknown) {
        sockets.push(this);
    }
    on(event: string, fn: (...args: any[]) => void) {
        this.handlers.set(event, fn);
        return this;
    }
    close() { this.closed = true; }
    pong() {}
}

vi.mock("ws", () => ({ default: FakeWS, WebSocket: FakeWS }));

const { RemoteConnectorService } = await import("../src/server/RemoteConnectorService.js");
import type { ConnectorRegistry } from "@openicf/connector-core";
import type { OAuthTokenProvider } from "../src/server/OAuthTokenProvider.js";

function makeService() {
    const invalidate = vi.fn();
    const oauth = {
        invalidate,
        getToken: async () => "tok",
        getTokenExpiryTime: () => Date.now() + 60_000,
    } as unknown as OAuthTokenProvider;

    const registry = {
        list: () => [], ids: () => [], disposeAll: async () => undefined,
    } as unknown as ConnectorRegistry;

    const service = new RemoteConnectorService({
        serverUrl: "wss://example.invalid/ws",
        registry,
        oauth,
    });

    // Keep reconnects out of the event loop; assert on the call instead.
    const scheduleReconnect = vi.fn();
    (service as any).scheduleReconnect = scheduleReconnect;

    (service as any).establishWebSocket("tok", Date.now() + 60_000);
    const socket = sockets[sockets.length - 1]!;
    const handler = socket.handlers.get("unexpected-response")!;

    return { service, socket, handler, invalidate, scheduleReconnect };
}

/** The client's own outgoing upgrade request: no Origin header, ever. */
const outgoingReq = { headers: { host: "example.invalid" } };

function makeRes(statusCode: number) {
    return { statusCode, resume: vi.fn() };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    sockets.length = 0;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

const logged = () =>
    [...errorSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0])).join("\n");

describe("unexpected-response handling", () => {
    it("invalidates the cached token on 401", () => {
        const { handler, invalidate, scheduleReconnect } = makeService();

        handler(outgoingReq, makeRes(401));

        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(scheduleReconnect).toHaveBeenCalledTimes(1);
    });

    it("invalidates the cached token on 403", () => {
        const { handler, invalidate } = makeService();
        handler(outgoingReq, makeRes(403));
        expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it("does not invalidate on 500, but still reconnects", () => {
        const { handler, invalidate, scheduleReconnect } = makeService();

        handler(outgoingReq, makeRes(500));

        expect(invalidate).not.toHaveBeenCalled();
        expect(scheduleReconnect).toHaveBeenCalledTimes(1);
    });

    it("logs nothing about csrf or origin", () => {
        const { handler } = makeService();

        handler(outgoingReq, makeRes(401));

        expect(logged()).not.toContain("[ws-csrf]");
        expect(logged()).not.toContain("[CSRF]");
        expect(logged()).not.toMatch(/origin/i);
    });

    it("drains the response stream and closes the socket in every case", () => {
        for (const status of [401, 403, 500, 502]) {
            const { handler, socket } = makeService();
            const res = makeRes(status);

            handler(outgoingReq, res);

            expect(res.resume).toHaveBeenCalledTimes(1);
            expect(socket.closed).toBe(true);
        }
    });
});
