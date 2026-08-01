import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { OperationStore } from "../../src/ops/OperationStore.js";
import { runOperationStoreContract } from "./operation-store.contract.js";
import {
  applySchema,
  openPool,
  probePostgres,
  resetOperations,
  type PgPool,
} from "../harness/pg.js";
import { describeWithPg } from "../harness/describeWithPg.js";

// Top-level await: the probe has to finish before suites are registered, which
// is what lets an unreachable server skip rather than fail.
const probe = await probePostgres();

describeWithPg(probe, "OperationStore against Postgres", () => {
  let pool: PgPool;

  beforeAll(async () => {
    pool = openPool(probe.url!);
    await applySchema(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await resetOperations(pool);
  });

  runOperationStoreContract("OperationStore (postgres)", () => ({
    store: new OperationStore(pool),
    expireHotRow: async (id: string) => {
      await pool.query("DELETE FROM operations WHERE id = $1", [id]);
    },
  }));

  it("never hands the same row to two concurrent claimers", async () => {
    // The claim protocol's core guarantee. Replicas coordinate through
    // SKIP LOCKED alone, so if this breaks, two dispatchers run the same
    // mutation against the target at the same time.
    const store = new OperationStore(pool);
    const lanes = 40;
    for (let i = 0; i < lanes; i++) {
      await store.enqueue({
        instanceId: "ad-prod",
        objectClass: "__ACCOUNT__",
        opType: "CREATE",
        laneKey: `lane-${i}`,
        idempotencyKey: `race-${i}`,
        nameAttrValue: `user${i}`,
      });
    }

    const avail = new Map([["ad-prod", lanes]]);
    const [a, b, c] = await Promise.all([
      store.claimBatch(lanes, [], avail),
      store.claimBatch(lanes, [], avail),
      store.claimBatch(lanes, [], avail),
    ]);

    const ids = [...a, ...b, ...c].map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);   // no row claimed twice
    expect(ids).toHaveLength(lanes);              // and none lost

    const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM operations WHERE status = 'RUNNING'",
    );
    expect(rows[0].n).toBe(lanes);
  });

  it("keeps idempotent enqueue single-rowed under concurrency", async () => {
    // The advisory lock is doing the work here: the unique index cannot,
    // because it must include created_at to exist on a partitioned table.
    const store = new OperationStore(pool);
    const results = await Promise.all(
        Array.from({ length: 8 }, () => store.enqueue({
          instanceId: "ad-prod",
          objectClass: "__ACCOUNT__",
          opType: "CREATE",
          laneKey: "create:__ACCOUNT__:solo",
          idempotencyKey: "one-and-only",
          nameAttrValue: "solo",
        })),
    );

    const ids = new Set(results.map(r => r.id));
    expect(ids.size).toBe(1);

    const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM operations WHERE idempotency_key = $1",
        ["one-and-only"],
    );
    expect(rows[0].n).toBe(1);
  });
});
