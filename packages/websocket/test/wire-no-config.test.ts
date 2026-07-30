import { describe, it, expect } from "vitest";
import { RemoteConnectorService } from "../src/server/RemoteConnectorService.js";
import type { ConnectorRegistry } from "@openicf/connector-core";
import type { OAuthTokenProvider } from "../src/server/OAuthTokenProvider.js";

const SECRET = "hunter2-do-not-ship";

/**
 * Lock-in, not a fix: no connector configuration currently reaches the wire.
 * These assertions exist so that stays true -- adding `config` to a
 * service-info or response payload would be an easy, plausible change.
 */
describe("wire payloads carry no connector configuration", () => {
    function makeService() {
        const registry = {
            ids: () => ["conn-a", "conn-b"],
            list: () => [
                { id: "conn-a", type: "a", connectorKey: { type: "a", version: "1.0.0" },
                  config: { password: SECRET }, impl: {} },
            ],
            disposeAll: async () => undefined,
        } as unknown as ConnectorRegistry;

        return new RemoteConnectorService({
            serverUrl: "wss://example.invalid/ws",
            registry,
            oauth: {} as OAuthTokenProvider,
        });
    }

    it("service-info reports connector ids only", () => {
        const service = makeService();
        const sent: unknown[] = [];
        (service as any).send = (m: unknown) => sent.push(m);

        (service as any).sendServiceInfo();

        expect(sent).toHaveLength(1);
        const payload = sent[0] as Record<string, unknown>;
        expect(payload.type).toBe("service-info");
        expect(payload.connectors).toEqual(["conn-a", "conn-b"]);
        expect(payload).not.toHaveProperty("config");
        expect(JSON.stringify(payload)).not.toContain(SECRET);
    });

    it("the list-connectors response carries ids only", async () => {
        const service = makeService();
        const sent: unknown[] = [];
        (service as any).send = (m: unknown) => sent.push(m);

        await (service as any).handleMessage(
            Buffer.from(JSON.stringify({ type: "list-connectors", requestId: "r1" })),
        );

        expect(sent).toHaveLength(1);
        const payload = sent[0] as Record<string, unknown>;
        expect(JSON.stringify(payload)).not.toContain(SECRET);
        expect(payload).not.toHaveProperty("config");
    });
});
