import { describe, it, expect, vi } from "vitest";
import { RemoteConnectorService } from "../src/server/RemoteConnectorService.js";
import type { ConnectorRegistry } from "@openicf/connector-core";
import type { OAuthTokenProvider } from "../src/server/OAuthTokenProvider.js";

/**
 * Build a service over stub collaborators. Never started, so there is no
 * WebSocket and no network: shutdown() exercises the teardown path only.
 */
function makeService(registry: Partial<ConnectorRegistry>) {
    return new RemoteConnectorService({
        serverUrl: "wss://example.invalid/ws",
        registry: registry as ConnectorRegistry,
        oauth: {} as OAuthTokenProvider,
    });
}

describe("RemoteConnectorService.shutdown", () => {
    it("disposes connectors", async () => {
        const disposeAll = vi.fn(async () => undefined);
        const service = makeService({ disposeAll, list: () => [], ids: () => [] });

        await service.shutdown();

        expect(disposeAll).toHaveBeenCalledTimes(1);
    });

    it("is idempotent: a second shutdown does not dispose again", async () => {
        const disposeAll = vi.fn(async () => undefined);
        const service = makeService({ disposeAll, list: () => [], ids: () => [] });

        await service.shutdown();
        await service.shutdown();

        // Asserts the service-level guard specifically. The registry is also
        // idempotent on its own (removal-always empties its map), but that is a
        // collaborator's implementation detail -- this pins the property here.
        expect(disposeAll).toHaveBeenCalledTimes(1);
    });
});
