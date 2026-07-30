import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { GuardedString, isGuardedString } from "../src/spi/GuardedString.js";

const SECRET = "s3cr3t-do-not-leak-9f2a";

describe("GuardedString", () => {
    it("reveals the value, and throws once cleared", () => {
        const gs = new GuardedString(SECRET);
        expect(gs.reveal()).toBe(SECRET);
        expect(gs.cleared).toBe(false);

        gs.clear();

        expect(gs.cleared).toBe(true);
        expect(() => gs.reveal()).toThrow("GuardedString has been cleared");
    });

    it("is recognised by the type guard", () => {
        expect(isGuardedString(new GuardedString(SECRET))).toBe(true);
        expect(isGuardedString(SECRET)).toBe(false);
        expect(isGuardedString(null)).toBe(false);
        expect(isGuardedString({ reveal: () => SECRET })).toBe(false);
    });

    describe("leak channels", () => {
        const gs = new GuardedString(SECRET);

        // Each entry is a way a secret realistically escapes into a log line.
        const channels: Array<[string, () => string]> = [
            ["template interpolation", () => `${gs}`],
            ["String()", () => String(gs)],
            ["JSON.stringify, bare", () => JSON.stringify(gs)],
            ["JSON.stringify, nested", () => JSON.stringify({ password: gs })],
            ["util.inspect, bare", () => inspect(gs)],
            ["util.inspect, nested", () => inspect({ password: gs })],
            ["util.inspect, deep", () => inspect({ a: { b: [gs] } }, { depth: 5 })],
            ["Array.join", () => [gs].join(",")],
            ["concatenation", () => "value=" + gs],
        ];

        for (const [name, produce] of channels) {
            it(`does not leak via ${name}`, () => {
                const out = produce();
                expect(out).not.toContain(SECRET);
                expect(out).toContain("[REDACTED]");
            });
        }
    });

    it("does not leak through error message interpolation", () => {
        const gs = new GuardedString(SECRET);
        const err = new Error(`auth failed for ${gs}`);

        expect(err.message).not.toContain(SECRET);
        expect(err.message).toContain("[REDACTED]");
        expect(inspect(err)).not.toContain(SECRET);
    });

    describe("safe failure under serialization", () => {
        it("does not carry the secret through structuredClone", () => {
            const gs = new GuardedString(SECRET);
            const clone = structuredClone({ credential: gs });

            // The private field is not an own property, so nothing is copied.
            // The husk is useless rather than dangerous.
            expect(JSON.stringify(clone)).not.toContain(SECRET);
            expect(inspect(clone)).not.toContain(SECRET);
        });

        it("does not carry the secret through a JSON round trip", () => {
            const gs = new GuardedString(SECRET);
            const round = JSON.parse(JSON.stringify({ credential: gs }));

            expect(round.credential).toBe("[REDACTED]");
            expect(JSON.stringify(round)).not.toContain(SECRET);
        });
    });

    it("still reveals after being read multiple times", () => {
        const gs = new GuardedString(SECRET);
        expect(gs.reveal()).toBe(SECRET);
        expect(gs.reveal()).toBe(SECRET);
    });
});
