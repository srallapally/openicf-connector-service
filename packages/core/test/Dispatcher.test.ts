import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConnectorRegistry } from "../src/registry/ConnectorRegistry.js";
import { ConnectorManager } from "../src/registry/ConnectorManager.js";
import { Dispatcher } from "../src/ops/Dispatcher.js";
import {
    admitAndEnqueue,
    laneKeyFor,
    AdmissionRejectedError,
    isAdmissionRejected,
} from "../src/ops/admission.js";
import { MemoryOperationStore } from "./harness/MemoryOperationStore.js";
import { makeFakeConnector, type FakeConnector } from "./harness/FakeConnector.js";
import type { RuntimeConfigInput } from "../src/config/runtime.js";
import type { EnqueueInput } from "../src/ops/OperationStore.js";

const OC = "__ACCOUNT__";

let store: MemoryOperationStore;
let registry: ConnectorRegistry;
let manager: ConnectorManager;
let dispatcher: Dispatcher;
let connector: FakeConnector;

interface SetupOpts {
    runtime?: RuntimeConfigInput;
    capabilities?: { idempotentDelta?: boolean; equalitySearchOnName?: boolean };
    connectorOpts?: Parameters<typeof makeFakeConnector>[0];
    instanceId?: string;
}

function setup(opts: SetupOpts = {}): void {
    const instanceId = opts.instanceId ?? "ad-prod";
    store = new MemoryOperationStore();
    registry = new ConnectorRegistry();
    connector = makeFakeConnector(opts.connectorOpts ?? {});

    registry.registerFactory("fake", "1.0.0", async () => connector);
    registry.registerCapabilities("fake", "1.0.0", {
        equalitySearchOnName: true,
        ...opts.capabilities,
    });
    registry.registerInstance(instanceId, "fake", "1.0.0", {}, opts.runtime ?? {});

    manager = new ConnectorManager(registry, { logger: { error: () => {} } });
    dispatcher = new Dispatcher({
        store,
        manager,
        registry,
        config: {
            backoffBaseMs: 10,
            backoffMaxMs: 20,
            readBackGraceMs: 5,
            logger: { error: () => {} },
        },
    });
}

afterEach(async () => {
    await dispatcher?.stop();
    vi.useRealTimers();
});

function enqueue(overrides: Partial<EnqueueInput> & { idempotencyKey: string }) {
    const base = {
        instanceId: "ad-prod",
        objectClass: OC,
        opType: "CREATE" as const,
        ...overrides,
    };
    return store.enqueue({
        ...base,
        laneKey: base.laneKey ?? laneKeyFor(base.opType, base.objectClass, base),
    } as EnqueueInput);
}

/**
 * Run cycles until every operation reaches a terminal state.
 *
 * Real time has to pass between cycles: deadlines, backoff windows, and the
 * read-back delay are all setTimeout-based, so draining microtasks alone would
 * declare the queue finished while work is still scheduled.
 */
async function drain(timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        await dispatcher.runCycle();
        await new Promise(r => setTimeout(r, 2));

        const open = store.allRows().some(r => r.status === "PENDING" || r.status === "RUNNING");
        if (!open && dispatcher.inFlightCount === 0) return;
    }
    throw new Error(
        `drain timed out after ${timeoutMs}ms; ` +
        `statuses: ${store.allRows().map(r => `${r.id}=${r.status}`).join(", ")}`,
    );
}

describe("lane keys", () => {
    it("keys a create on the naming attribute and a mutation on the uid", () => {
        expect(laneKeyFor("CREATE", OC, { nameAttrValue: "jdoe" })).toBe("create:__ACCOUNT__:jdoe");
        expect(laneKeyFor("UPDATE", OC, { uid: "u1" })).toBe("uid:__ACCOUNT__:u1");
        expect(laneKeyFor("DELETE", OC, { uid: "u1" })).toBe("uid:__ACCOUNT__:u1");
    });

    it("namespaces the two forms so they cannot collide", () => {
        expect(laneKeyFor("CREATE", OC, { nameAttrValue: "x" }))
            .not.toBe(laneKeyFor("DELETE", OC, { uid: "x" }));
    });

    it("refuses to build a key without the identity it needs", () => {
        expect(() => laneKeyFor("CREATE", OC, {})).toThrow(/naming attribute/);
        expect(() => laneKeyFor("UPDATE", OC, {})).toThrow(/uid/);
    });
});

describe("CREATE resolution", () => {
    it("succeeds and persists the target-minted uid", async () => {
        setup();
        const { id } = await enqueue({ idempotencyKey: "c1", nameAttrValue: "jdoe", attrs: { __NAME__: "jdoe" } });

        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        expect((row!.result as any).uid).toMatch(/^uid-\d+$/);
        expect((row!.result as any).object.attributes.__NAME__).toBe("jdoe");
    });

    it("records ALREADY_EXISTS as a confirmed failure", async () => {
        setup();
        await connector.create!(OC, { __NAME__: "taken" });

        const { id } = await enqueue({ idempotencyKey: "c2", nameAttrValue: "taken", attrs: { __NAME__: "taken" } });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("FAILED_CONFIRMED");
        expect(row!.errorCode).toBe("ALREADY_EXISTS");
    });

    it("recovers a timed-out create by reading back the object it made", async () => {
        // The INDETERMINATE case CP-1 designed read-back for: the target
        // applied the create, the answer never arrived, and retrying blind
        // would produce a duplicate account.
        setup({ runtime: { attemptDeadlineMs: 20 } });
        connector.controls.applyThenHang();

        const { id } = await enqueue({ idempotencyKey: "c3", nameAttrValue: "ghost", attrs: { __NAME__: "ghost" } });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        expect((row!.result as any).viaReadBack).toBe(true);
        expect((row!.result as any).uid).toBeDefined();
        // Exactly one account, not two.
        expect(connector.controls.target.size).toBe(1);
    });

    it("retries once when read-back confirms the create never landed", async () => {
        setup({ runtime: { attemptDeadlineMs: 20 } });
        connector.controls.hangUntilAborted();   // nothing applied

        const { id } = await enqueue({ idempotencyKey: "c4", nameAttrValue: "retry", attrs: { __NAME__: "retry" } });
        await drain();

        const row = await store.getStatus(id);
        // First attempt timed out and read-back missed, so one retry ran and
        // succeeded on a healthy connector.
        expect(row!.status).toBe("SUCCEEDED");
        expect(connector.controls.countOf("create")).toBe(2);
    });

    it("records INDETERMINATE immediately when the connector cannot search by name", async () => {
        setup({
            runtime: { attemptDeadlineMs: 20 },
            capabilities: { equalitySearchOnName: false },
            connectorOpts: { equalitySearchOnName: false },
        });
        connector.controls.applyThenHang();

        const { id } = await enqueue({ idempotencyKey: "c5", nameAttrValue: "lost", attrs: { __NAME__: "lost" } });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("INDETERMINATE");
        expect(row!.errorCode).toBe("DEADLINE_NO_READBACK");
        // No read-back was attempted; reconciliation is the backstop.
        expect(connector.controls.countOf("search")).toBe(0);
    });
});

describe("DELETE resolution", () => {
    it("treats UNKNOWN_UID as success, because the object is absent", async () => {
        setup();
        const { id } = await enqueue({
            idempotencyKey: "d1", opType: "DELETE", uid: "never-existed",
        });

        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        expect((row!.result as any).alreadyAbsent).toBe(true);
    });

    it("deletes an existing object", async () => {
        setup();
        const created = await connector.create!(OC, { __NAME__: "doomed" });
        const { id } = await enqueue({ idempotencyKey: "d2", opType: "DELETE", uid: created.uid });

        await drain();

        expect((await store.getStatus(id))!.status).toBe("SUCCEEDED");
        expect(connector.controls.target.size).toBe(0);
    });

    it("retries a retryable failure and then succeeds", async () => {
        setup();
        const created = await connector.create!(OC, { __NAME__: "flaky" });
        connector.controls.failNext("CONNECTION_FAILED");

        const { id } = await enqueue({ idempotencyKey: "d3", opType: "DELETE", uid: created.uid });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        expect(row!.attemptCount).toBeGreaterThanOrEqual(1);
    });

    it("stops retrying at the attempt cap", async () => {
        setup();
        const created = await connector.create!(OC, { __NAME__: "hopeless" });
        // Re-arm on every call so it never succeeds.
        const origDelete = connector.delete!.bind(connector);
        (connector as any).delete = async (...args: any[]) => {
            connector.controls.failNext("CONNECTION_FAILED");
            return origDelete(...(args as [any, any, any]));
        };

        const { id } = await enqueue({ idempotencyKey: "d4", opType: "DELETE", uid: created.uid });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("INDETERMINATE");
        expect(row!.attemptCount).toBe(4);   // maxAttempts 5 => 4 requeues
    });

    it("records a non-retryable failure as confirmed", async () => {
        setup();
        const created = await connector.create!(OC, { __NAME__: "denied" });
        connector.controls.failNext("PERMISSION_DENIED");

        const { id } = await enqueue({ idempotencyKey: "d5", opType: "DELETE", uid: created.uid });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("FAILED_CONFIRMED");
        expect(row!.errorCode).toBe("PERMISSION_DENIED");
    });
});

describe("UPDATE resolution and the delta retry gate", () => {
    it("retries a replace update after a deadline", async () => {
        setup({ runtime: { attemptDeadlineMs: 20 } });
        const created = await connector.create!(OC, { __NAME__: "u" });
        connector.controls.hangUntilAborted();

        const { id } = await enqueue({
            idempotencyKey: "u1", opType: "UPDATE", uid: created.uid, attrs: { title: "staff" },
        });
        await drain();

        // Replace semantics are idempotent by construction, so the retry is safe.
        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        expect(connector.controls.countOf("update")).toBe(2);
    });

    it("refuses to retry a non-idempotent delta and records INDETERMINATE", async () => {
        // Replaying an increment or an append silently corrupts the target,
        // so an unasserted delta must never be retried.
        setup({ runtime: { attemptDeadlineMs: 20 }, capabilities: { idempotentDelta: false } });
        const created = await connector.create!(OC, { __NAME__: "u" });
        connector.controls.hangUntilAborted();

        const { id } = await enqueue({
            idempotencyKey: "u2", opType: "UPDATE", uid: created.uid,
            attrs: { __DELTA__: true, groups: ["a"] },
        });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("INDETERMINATE");
        expect(row!.errorCode).toBe("DELTA_NOT_IDEMPOTENT");
        expect(connector.controls.countOf("update")).toBe(1);
    });

    it("retries a delta the manifest declares idempotent", async () => {
        setup({ runtime: { attemptDeadlineMs: 20 }, capabilities: { idempotentDelta: true } });
        const created = await connector.create!(OC, { __NAME__: "u" });
        connector.controls.hangUntilAborted();

        const { id } = await enqueue({
            idempotencyKey: "u3", opType: "UPDATE", uid: created.uid,
            attrs: { __DELTA__: true, groups: ["a"] },
        });
        await drain();

        expect((await store.getStatus(id))!.status).toBe("SUCCEEDED");
        expect(connector.controls.countOf("update")).toBe(2);
    });

    it("records UNKNOWN_UID on update as a confirmed failure", async () => {
        // Unlike delete, an update of a missing object cannot reach its
        // desired end state.
        setup();
        const { id } = await enqueue({
            idempotencyKey: "u4", opType: "UPDATE", uid: "ghost", attrs: { title: "x" },
        });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("FAILED_CONFIRMED");
        expect(row!.errorCode).toBe("UNKNOWN_UID");
    });
});

describe("lane serialization", () => {
    it("never runs two operations on one lane concurrently", async () => {
        setup({ runtime: { mutationConcurrency: 10 } });
        const created = await connector.create!(OC, { __NAME__: "hot" });

        let concurrent = 0;
        let maxConcurrent = 0;
        const origUpdate = connector.update!.bind(connector);
        (connector as any).update = async (...args: any[]) => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            try { return await origUpdate(...(args as [any, any, any, any])); }
            finally { concurrent--; }
        };

        for (let i = 0; i < 5; i++) {
            await enqueue({
                idempotencyKey: `lane-${i}`, opType: "UPDATE", uid: created.uid,
                attrs: { title: `t${i}` },
            });
        }
        await drain();

        expect(maxConcurrent).toBe(1);
        expect(connector.controls.countOf("update")).toBe(5);
    });

    it("runs different lanes in parallel", async () => {
        setup({ runtime: { mutationConcurrency: 10 } });

        let concurrent = 0;
        let maxConcurrent = 0;
        const origCreate = connector.create!.bind(connector);
        (connector as any).create = async (...args: any[]) => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            try {
                await new Promise(r => setTimeout(r, 5));
                return await origCreate(...(args as [any, any, any]));
            } finally { concurrent--; }
        };

        for (let i = 0; i < 5; i++) {
            await enqueue({
                idempotencyKey: `par-${i}`, nameAttrValue: `user${i}`, attrs: { __NAME__: `user${i}` },
            });
        }
        await drain();

        expect(maxConcurrent).toBeGreaterThan(1);
    });
});

describe("priority", () => {
    it("dispatches interactive work ahead of a batch backlog", async () => {
        setup({ runtime: { mutationConcurrency: 1 } });

        for (let i = 0; i < 10; i++) {
            await enqueue({
                idempotencyKey: `b-${i}`, nameAttrValue: `batch${i}`, attrs: { __NAME__: `batch${i}` },
            });
        }
        await enqueue({
            idempotencyKey: "urgent", nameAttrValue: "helpdesk",
            attrs: { __NAME__: "helpdesk" }, priority: "interactive",
        });

        await drain();

        const order = connector.controls.calls
            .filter(c => c.op === "create")
            .map(c => (c.args[1] as any).__NAME__);

        // Enqueued last, dispatched first.
        expect(order[0]).toBe("helpdesk");
    });
});

describe("concurrency budget", () => {
    it("holds in-flight mutations at the configured budget", async () => {
        setup({ runtime: { mutationConcurrency: 2 } });

        let concurrent = 0;
        let maxConcurrent = 0;
        const origCreate = connector.create!.bind(connector);
        (connector as any).create = async (...args: any[]) => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            try {
                await new Promise(r => setTimeout(r, 5));
                return await origCreate(...(args as [any, any, any]));
            } finally { concurrent--; }
        };

        for (let i = 0; i < 8; i++) {
            await enqueue({
                idempotencyKey: `cap-${i}`, nameAttrValue: `u${i}`, attrs: { __NAME__: `u${i}` },
            });
        }
        await drain();

        expect(maxConcurrent).toBeLessThanOrEqual(2);
        expect(connector.controls.countOf("create")).toBe(8);
    });
});

describe("admission", () => {
    it("admits below the cap and rejects at it, reporting depth", async () => {
        setup();

        await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "a1", nameAttrValue: "one", attrs: { __NAME__: "one" },
        }, { batch: 2 });
        await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "a2", nameAttrValue: "two", attrs: { __NAME__: "two" },
        }, { batch: 2 });

        const err = await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "a3", nameAttrValue: "three", attrs: { __NAME__: "three" },
        }, { batch: 2 }).catch(e => e);

        expect(isAdmissionRejected(err)).toBe(true);
        expect((err as AdmissionRejectedError).backlogDepth).toBe(2);
        expect((err as AdmissionRejectedError).cap).toBe(2);
    });

    it("caps the two priority classes separately", async () => {
        setup();
        await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "p1", nameAttrValue: "b", attrs: { __NAME__: "b" },
        }, { batch: 1, interactive: 1 });

        // Batch is full; interactive still has room.
        await expect(admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "p2", nameAttrValue: "b2", attrs: { __NAME__: "b2" },
        }, { batch: 1, interactive: 1 })).rejects.toThrow(AdmissionRejectedError);

        await expect(admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "p3", nameAttrValue: "i", attrs: { __NAME__: "i" },
            priority: "interactive",
        }, { batch: 1, interactive: 1 })).resolves.toBeDefined();
    });

    it("derives the lane key when the caller does not supply one", async () => {
        setup();
        const { id } = await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "DELETE",
            idempotencyKey: "lk", uid: "u-9",
        });
        const row = store.allRows().find(r => r.id === id);
        expect(row!.laneKey).toBe("uid:__ACCOUNT__:u-9");
    });

    it("frees capacity as the backlog drains", async () => {
        setup();
        await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "f1", nameAttrValue: "x", attrs: { __NAME__: "x" },
        }, { batch: 1 });

        await drain();

        await expect(admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "f2", nameAttrValue: "y", attrs: { __NAME__: "y" },
        }, { batch: 1 })).resolves.toBeDefined();
    });
});

describe("failure handling", () => {
    it("records REJECTED_PRE_DISPATCH when the connector cannot be built", async () => {
        store = new MemoryOperationStore();
        registry = new ConnectorRegistry();
        registry.registerFactory("broken", "1.0.0", async () => { throw new Error("no credentials"); });
        registry.registerInstance("ad-prod", "broken", "1.0.0", {});
        manager = new ConnectorManager(registry, { logger: { error: () => {} } });
        dispatcher = new Dispatcher({ store, manager, registry, config: { logger: { error: () => {} } } });

        const { id } = await enqueue({ idempotencyKey: "x1", nameAttrValue: "x", attrs: { __NAME__: "x" } });
        await drain();

        const row = await store.getStatus(id);
        // Nothing reached the target, so this is safe to retry wholesale.
        expect(row!.status).toBe("REJECTED_PRE_DISPATCH");
        expect(row!.errorCode).toBe("ACQUIRE_FAILED");
    });

    it("releases the lease after every attempt, including failures", async () => {
        setup();
        connector.controls.failNext("PERMISSION_DENIED");
        await enqueue({ idempotencyKey: "r1", nameAttrValue: "x", attrs: { __NAME__: "x" } });
        await drain();

        expect(manager.refcountOf("ad-prod")).toBe(0);
    });
});

describe("lifecycle", () => {
    it("stops claiming after stop() and waits for in-flight work", async () => {
        setup();
        await enqueue({ idempotencyKey: "s1", nameAttrValue: "x", attrs: { __NAME__: "x" } });

        await dispatcher.stop();
        const claimed = await dispatcher.runCycle();

        expect(claimed).toBe(0);
        expect(dispatcher.inFlightCount).toBe(0);
    });

    it("skips an overlapping cycle rather than double-claiming", async () => {
        setup();
        for (let i = 0; i < 3; i++) {
            await enqueue({ idempotencyKey: `o-${i}`, nameAttrValue: `u${i}`, attrs: { __NAME__: `u${i}` } });
        }

        const [a, b] = await Promise.all([dispatcher.runCycle(), dispatcher.runCycle()]);
        // The second observed a cycle already running and did nothing.
        expect(Math.min(a, b)).toBe(0);
        await drain();
    });
});
