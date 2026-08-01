import { describe, it, expect } from "vitest";
import { ConnectorError, isConnectorError } from "../src/spi/errors.js";
import type { ConnectorErrorCode } from "../src/spi/errors.js";

describe("ConnectorError", () => {
    it("is a real Error with a usable name and message", () => {
        const e = new ConnectorError("UNKNOWN_UID", "no such user");
        expect(e).toBeInstanceOf(Error);
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.name).toBe("ConnectorError");
        expect(e.message).toBe("no such user");
        expect(typeof e.stack).toBe("string");
    });

    it("defaults retryable to true only for the two transport codes", () => {
        const retryable: ConnectorErrorCode[] = ["CONNECTION_FAILED", "RATE_LIMIT_TARGET"];
        const terminal: ConnectorErrorCode[] = [
            "ALREADY_EXISTS",
            "UNKNOWN_UID",
            "INVALID_ATTRIBUTE",
            "PERMISSION_DENIED",
            "UNKNOWN",
        ];

        for (const code of retryable) {
            expect(new ConnectorError(code, "x").retryable, code).toBe(true);
        }
        for (const code of terminal) {
            expect(new ConnectorError(code, "x").retryable, code).toBe(false);
        }
    });

    it("lets the thrower override retryable in both directions", () => {
        // A target that returns 503 on a malformed payload is still worth one
        // more attempt; a target whose throttle is a hard daily quota is not.
        expect(new ConnectorError("INVALID_ATTRIBUTE", "x", { retryable: true }).retryable).toBe(true);
        expect(new ConnectorError("RATE_LIMIT_TARGET", "x", { retryable: false }).retryable).toBe(false);
    });

    it("preserves the wrapped cause", () => {
        const cause = new Error("ECONNRESET");
        const e = new ConnectorError("CONNECTION_FAILED", "target unreachable", { cause });
        expect(e.cause).toBe(cause);
    });

    it("omits cause entirely when not supplied", () => {
        expect(new ConnectorError("UNKNOWN", "x").cause).toBeUndefined();
        // An explicit undefined cause is still an explicit cause.
        expect("cause" in new ConnectorError("UNKNOWN", "x", { cause: undefined })).toBe(true);
    });

    it("keeps code readable on the instance", () => {
        expect(new ConnectorError("PERMISSION_DENIED", "x").code).toBe("PERMISSION_DENIED");
    });
});

describe("isConnectorError", () => {
    it("accepts a ConnectorError", () => {
        expect(isConnectorError(new ConnectorError("UNKNOWN", "x"))).toBe(true);
    });

    it("rejects plain errors and non-errors", () => {
        for (const v of [new Error("x"), new TypeError("x"), null, undefined, "UNKNOWN_UID", { code: "UNKNOWN_UID" }]) {
            expect(isConnectorError(v)).toBe(false);
        }
    });

    it("narrows the type so code is reachable", () => {
        const e: unknown = new ConnectorError("ALREADY_EXISTS", "dup");
        if (!isConnectorError(e)) throw new Error("guard failed");
        expect(e.code).toBe("ALREADY_EXISTS");
    });
});
