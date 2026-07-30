import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Importing RemoteConnectorService must not start the service.
 *
 * Asserting only that the export exists is not enough. When the module runs
 * main() on import, main() throws on the missing env vars and its .catch calls
 * process.exit(1). Vitest sandboxes process.exit, so that surfaces as a
 * run-level error rather than a test failure -- the test itself still reports
 * as passing. These assertions therefore watch for the side effects directly.
 */
describe("RemoteConnectorService module", () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandled.push(reason); };

    afterEach(() => {
        process.off("unhandledRejection", onUnhandledRejection);
        unhandled.length = 0;
        vi.restoreAllMocks();
    });

    it("can be imported without env vars and without starting anything", async () => {
        delete process.env.REMOTE_CONNECTOR_WS_URL;
        delete process.env.OAUTH_TOKEN_URL;
        delete process.env.OAUTH_CLIENT_ID;
        delete process.env.OAUTH_CLIENT_SECRET;

        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        process.on("unhandledRejection", onUnhandledRejection);

        vi.resetModules();
        const mod = await import("../src/server/RemoteConnectorService.js");

        // main()'s rejection is handled on a microtask, and process.exit would
        // be called from there. Let the queue drain before asserting.
        await new Promise((resolve) => setImmediate(resolve));

        expect(typeof mod.RemoteConnectorService).toBe("function");
        expect(exitSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
    });
});
