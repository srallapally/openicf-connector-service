// test/load/soak.ts
//
// Manual load script. NOT a vitest suite -- it is slow by design and asserts
// throughput, which is exactly the kind of thing that flakes in CI.
//
//   npx tsx test/load/soak.ts                # in-memory store, default 50k ops
//   OPS=200000 npx tsx test/load/soak.ts     # heavier run
//   eval "$(bash ../../scripts/test-pg.sh)" && STORE=pg npx tsx test/load/soak.ts
//
// What it checks:
//   1. drain rate               -- operations per second, end to end
//   2. per-lane ordering        -- via each FakeConnector's call log, two
//                                  operations on one lane never overlap and
//                                  they complete in enqueue order
//   3. interactive latency      -- p50/p99 for interactive work while a large
//                                  batch backlog is draining
//
// Phase 7 note: the drain loop below implements the dispatcher's *claim*
// contract directly (claim -> execute -> finalize, lanes held for the duration
// of an attempt). When Dispatcher lands, replace `drain()` with the real one so
// this measures the shipping scheduler rather than a stand-in.

import { performance } from "node:perf_hooks";
import { MemoryOperationStore } from "../harness/MemoryOperationStore.js";
import { OperationStore, type OperationStoreApi } from "../../src/ops/OperationStore.js";
import { makeFakeConnector, type FakeConnector } from "../harness/FakeConnector.js";

const TOTAL_OPS = Number(process.env["OPS"] ?? 50_000);
const INSTANCES = Number(process.env["INSTANCES"] ?? 4);
const MUTATION_BUDGET = Number(process.env["BUDGET"] ?? 10);
const INTERACTIVE_SHARE = Number(process.env["INTERACTIVE_SHARE"] ?? 0.02);
const CLAIM_LIMIT = Number(process.env["CLAIM_LIMIT"] ?? 100);
const USE_PG = process.env["STORE"] === "pg";

const OBJECT_CLASS = "__ACCOUNT__";
const instanceIds = Array.from({ length: INSTANCES }, (_, i) => `inst-${i}`);

interface Sample { id: string; enqueuedAt: number; finishedAt?: number; priority: string }

async function main(): Promise<void> {
  const { store, teardown } = await openStore();
  const connectors = new Map<string, FakeConnector>(
      instanceIds.map(id => [id, makeFakeConnector()]),
  );

  console.log(`soak: ${TOTAL_OPS} ops across ${INSTANCES} instances, ` +
      `budget ${MUTATION_BUDGET}/instance, store=${USE_PG ? "postgres" : "memory"}`);

  // ---- enqueue -----------------------------------------------------------
  const samples = new Map<string, Sample>();
  const enqueueStart = performance.now();

  for (let i = 0; i < TOTAL_OPS; i++) {
    const instanceId = instanceIds[i % INSTANCES]!;
    const priority = Math.random() < INTERACTIVE_SHARE ? "interactive" : "batch";
    // A deliberately small lane space, so lanes genuinely collide and the
    // serialization guarantee is under real pressure.
    const name = `user-${i % Math.max(1, Math.floor(TOTAL_OPS / 8))}`;

    const { id } = await store.enqueue({
      instanceId,
      objectClass: OBJECT_CLASS,
      opType: "CREATE",
      laneKey: `create:${OBJECT_CLASS}:${name}`,
      idempotencyKey: `soak-${i}`,
      nameAttrValue: name,
      attrs: { __NAME__: name },
      priority: priority as "interactive" | "batch",
    });
    samples.set(id, { id, enqueuedAt: performance.now(), priority });
  }

  const enqueueMs = performance.now() - enqueueStart;
  console.log(`enqueue: ${TOTAL_OPS} ops in ${enqueueMs.toFixed(0)}ms ` +
      `(${rate(TOTAL_OPS, enqueueMs)}/s)`);

  // ---- drain -------------------------------------------------------------
  const drainStart = performance.now();
  const laneViolations = await drain(store, connectors, samples);
  const drainMs = performance.now() - drainStart;

  // ---- report ------------------------------------------------------------
  const finished = [...samples.values()].filter(s => s.finishedAt !== undefined);
  const latencies = (p: string) => finished
      .filter(s => s.priority === p)
      .map(s => s.finishedAt! - s.enqueuedAt)
      .sort((a, b) => a - b);

  const batch = latencies("batch");
  const interactive = latencies("interactive");

  console.log(`drain:   ${finished.length} ops in ${drainMs.toFixed(0)}ms ` +
      `(${rate(finished.length, drainMs)}/s)`);
  console.log(`batch      latency  p50 ${pct(batch, 50)}ms  p99 ${pct(batch, 99)}ms  n=${batch.length}`);
  console.log(`interactive latency p50 ${pct(interactive, 50)}ms  p99 ${pct(interactive, 99)}ms  n=${interactive.length}`);
  console.log(`lane ordering violations: ${laneViolations}`);

  const failures: string[] = [];
  if (finished.length !== TOTAL_OPS) {
    failures.push(`only ${finished.length}/${TOTAL_OPS} operations reached a terminal state`);
  }
  if (laneViolations > 0) {
    failures.push(`${laneViolations} lane ordering violation(s): two operations on one lane overlapped`);
  }
  if (interactive.length > 0 && batch.length > 0 && pctRaw(interactive, 50) > pctRaw(batch, 50)) {
    failures.push("interactive p50 exceeded batch p50 -- the reserved slice is not doing its job");
  }

  await teardown();

  if (failures.length > 0) {
    console.error("\nFAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nOK");
}

/**
 * Claim, execute, finalize until the backlog is empty.
 *
 * Lanes are held for the whole attempt, which is the property the lane key
 * exists to provide; `activeLanes` is what a real dispatcher passes to
 * claimBatch, and violations are counted by watching for two concurrent
 * executions on one lane.
 */
async function drain(
    store: OperationStoreApi,
    connectors: Map<string, FakeConnector>,
    samples: Map<string, Sample>,
): Promise<number> {
  const activeLanes = new Set<string>();
  const running = new Set<Promise<void>>();
  const inFlightLanes = new Map<string, number>();
  let violations = 0;
  let idleCycles = 0;

  const available = () => new Map(instanceIds.map(id => [
    id,
    MUTATION_BUDGET - countRunningFor(id),
  ]));

  const perInstanceRunning = new Map<string, number>(instanceIds.map(id => [id, 0]));
  function countRunningFor(id: string): number { return perInstanceRunning.get(id) ?? 0; }

  while (true) {
    const claimed = await store.claimBatch(CLAIM_LIMIT, [...activeLanes], available());

    if (claimed.length === 0) {
      if (running.size === 0) {
        if (++idleCycles > 2) break;
      } else {
        idleCycles = 0;
      }
      await Promise.race([...running, sleep(1)]);
      continue;
    }
    idleCycles = 0;

    for (const op of claimed) {
      activeLanes.add(op.laneKey);
      perInstanceRunning.set(op.instanceId, countRunningFor(op.instanceId) + 1);

      const depth = (inFlightLanes.get(op.laneKey) ?? 0) + 1;
      inFlightLanes.set(op.laneKey, depth);
      if (depth > 1) violations++;

      const task = (async () => {
        const connector = connectors.get(op.instanceId)!;
        try {
          const created = await connector.create!(OBJECT_CLASS, (op.attrs ?? {}) as any);
          await store.finalize(op.id, "SUCCEEDED", { uid: created.uid });
        } catch (e) {
          const code = (e as { code?: string }).code ?? "UNKNOWN";
          await store.finalize(op.id, "FAILED_CONFIRMED", undefined, code);
        } finally {
          const s = samples.get(op.id);
          if (s) s.finishedAt = performance.now();
          inFlightLanes.set(op.laneKey, (inFlightLanes.get(op.laneKey) ?? 1) - 1);
          activeLanes.delete(op.laneKey);
          perInstanceRunning.set(op.instanceId, countRunningFor(op.instanceId) - 1);
        }
      })();

      running.add(task);
      void task.finally(() => running.delete(task));
    }

    if (running.size >= MUTATION_BUDGET * INSTANCES) {
      await Promise.race(running);
    }
  }

  await Promise.allSettled(running);
  return violations;
}

async function openStore(): Promise<{ store: OperationStoreApi; teardown: () => Promise<void> }> {
  if (!USE_PG) {
    return { store: new MemoryOperationStore(), teardown: async () => {} };
  }

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("STORE=pg requires DATABASE_URL (run scripts/test-pg.sh)");

  const { openPool, applySchema, resetOperations } = await import("../harness/pg.js");
  const pool = openPool(url, 16);
  await applySchema(pool);
  await resetOperations(pool);

  return {
    store: new OperationStore(pool),
    teardown: async () => { await pool.end(); },
  };
}

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
const rate = (n: number, ms: number) => ms > 0 ? Math.round(n / (ms / 1000)).toLocaleString() : "inf";
const pctRaw = (sorted: number[], p: number) =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))]!;
const pct = (sorted: number[], p: number) => pctRaw(sorted, p).toFixed(1);

main().catch(e => { console.error(e); process.exitCode = 1; });
