// test/harness/MemoryOperationStore.ts
//
// In-memory OperationStore, used by dispatcher tests so they can run without a
// database. It is held to the same contract suite as the Postgres store
// (test/contract/operation-store.contract.ts), which is the only thing keeping
// the two from drifting.
//
// Where Postgres gives an ordering or atomicity guarantee, this reproduces the
// observable consequence rather than the mechanism: claims are serialized by
// the single-threaded event loop instead of SKIP LOCKED, but a row can still
// only be claimed once.

import type {
  ClaimedOperation,
  EnqueueInput,
  EnqueueResult,
  OperationStatusRow,
  OperationStoreApi,
  OperationType,
  PendingCounts,
} from "../../src/ops/OperationStore.js";
import type { OperationOutcome, OperationPriority, OperationStatus } from "../../src/spi/types.js";

const TERMINAL: ReadonlySet<string> = new Set<OperationOutcome>([
  "SUCCEEDED",
  "REJECTED_PRE_DISPATCH",
  "FAILED_CONFIRMED",
  "INDETERMINATE",
]);

interface Row {
  id: string;
  instanceId: string;
  objectClass: string;
  opType: OperationType;
  priority: OperationPriority;
  status: OperationStatus;
  laneKey: string;
  uid: string | null;
  nameAttrValue: string | null;
  attrs: Record<string, unknown> | null;
  result: unknown | null;
  errorCode: string | null;
  attemptCount: number;
  createdAt: Date;
  finalizedAt: Date | null;
  idempotencyKey: string;
}

interface HistoryRow {
  id: string;
  instanceId: string;
  objectClass: string;
  opType: OperationType;
  status: OperationStatus;
  uid: string | null;
  errorCode: string | null;
  createdAt: Date;
  finalizedAt: Date;
}

export interface MemoryOperationStoreOptions {
  /** Clock seam, so ordering is deterministic under fake timers. */
  now?: () => number;
}

export class MemoryOperationStore implements OperationStoreApi {
  private readonly rows = new Map<string, Row>();
  private readonly history = new Map<string, HistoryRow>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private seq = 0;
  private readonly now: () => number;

  constructor(opts: MemoryOperationStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Test affordance: drop the hot row while keeping history, as retention would. */
  expireHotRow(id: string): void {
    this.rows.delete(id);
  }

  /** Test affordance: every row, insertion-ordered. */
  allRows(): ReadonlyArray<Readonly<Row>> {
    return Array.from(this.rows.values());
  }

  async enqueue(op: EnqueueInput): Promise<EnqueueResult> {
    const existingId = this.byIdempotencyKey.get(op.idempotencyKey);
    if (existingId !== undefined) return { id: existingId, deduplicated: true };

    const id = `op-${++this.seq}`;
    // Monotonic within a millisecond: two ops enqueued in the same tick must
    // still have a stable claim order, which real timestamps would not give.
    const createdAt = new Date(this.now() + this.seq / 1e6);

    this.rows.set(id, {
      id,
      instanceId: op.instanceId,
      objectClass: op.objectClass,
      opType: op.opType,
      priority: op.priority ?? "batch",
      status: "PENDING",
      laneKey: op.laneKey,
      uid: op.uid ?? null,
      nameAttrValue: op.nameAttrValue ?? null,
      attrs: op.attrs ?? null,
      result: null,
      errorCode: null,
      attemptCount: 0,
      createdAt,
      finalizedAt: null,
      idempotencyKey: op.idempotencyKey,
    });
    this.byIdempotencyKey.set(op.idempotencyKey, id);
    return { id, deduplicated: false };
  }

  async claimBatch(
      limit: number,
      activeLaneKeys: readonly string[],
      perInstanceAvailable: ReadonlyMap<string, number>,
  ): Promise<ClaimedOperation[]> {
    if (limit <= 0) return [];

    const busy = new Set(activeLaneKeys);
    const remaining = new Map<string, number>();
    for (const [instanceId, n] of perInstanceAvailable) {
      if (n > 0) remaining.set(instanceId, n);
    }
    if (remaining.size === 0) return [];

    const candidates = Array.from(this.rows.values())
        .filter(r => r.status === "PENDING")
        .filter(r => remaining.has(r.instanceId))
        .filter(r => !busy.has(r.laneKey))
        .sort(compareClaimOrder);

    const claimed: ClaimedOperation[] = [];
    // A lane may appear more than once in the backlog; claiming two operations
    // on one lane in a single cycle would defeat the serialization the lane
    // exists for.
    const takenLanes = new Set<string>();

    for (const row of candidates) {
      if (claimed.length >= limit) break;
      const left = remaining.get(row.instanceId) ?? 0;
      if (left <= 0) continue;
      if (takenLanes.has(row.laneKey)) continue;

      row.status = "RUNNING";
      remaining.set(row.instanceId, left - 1);
      takenLanes.add(row.laneKey);
      claimed.push(toClaimed(row));
    }

    return claimed;
  }

  async finalize(
      id: string,
      outcome: OperationOutcome,
      result?: unknown,
      errorCode?: string | null,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row) return false;
    if (TERMINAL.has(row.status)) return false;

    row.status = outcome;
    if (result !== undefined) row.result = result;
    row.errorCode = errorCode ?? null;
    row.finalizedAt = new Date(this.now());

    const resultUid = extractUid(row.result);
    this.history.set(id, {
      id: row.id,
      instanceId: row.instanceId,
      objectClass: row.objectClass,
      opType: row.opType,
      status: row.status,
      uid: row.uid ?? resultUid,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      finalizedAt: row.finalizedAt,
    });
    return true;
  }

  async requeue(id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== "RUNNING") return false;
    row.status = "PENDING";
    row.attemptCount += 1;
    return true;
  }

  async pendingCounts(instanceId: string): Promise<PendingCounts> {
    const counts: PendingCounts = { interactive: 0, batch: 0 };
    for (const row of this.rows.values()) {
      if (row.instanceId !== instanceId || row.status !== "PENDING") continue;
      if (row.priority === "interactive") counts.interactive++;
      else counts.batch++;
    }
    return counts;
  }

  async getStatus(id: string): Promise<OperationStatusRow | null> {
    const row = this.rows.get(id);
    if (row) {
      return {
        id: row.id,
        instanceId: row.instanceId,
        objectClass: row.objectClass,
        opType: row.opType,
        status: row.status,
        attemptCount: row.attemptCount,
        result: row.result,
        errorCode: row.errorCode,
        createdAt: row.createdAt,
        finalizedAt: row.finalizedAt,
        fromHistory: false,
      };
    }

    const hist = this.history.get(id);
    if (!hist) return null;
    return {
      id: hist.id,
      instanceId: hist.instanceId,
      objectClass: hist.objectClass,
      opType: hist.opType,
      status: hist.status,
      attemptCount: 0,
      result: hist.uid ? { uid: hist.uid } : null,
      errorCode: hist.errorCode,
      createdAt: hist.createdAt,
      finalizedAt: hist.finalizedAt,
      fromHistory: true,
    };
  }
}

/** Interactive ahead of batch, then oldest first -- the SQL's ORDER BY. */
function compareClaimOrder(a: Row, b: Row): number {
  const aI = a.priority === "interactive" ? 0 : 1;
  const bI = b.priority === "interactive" ? 0 : 1;
  if (aI !== bI) return aI - bI;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

function toClaimed(row: Row): ClaimedOperation {
  return {
    id: row.id,
    instanceId: row.instanceId,
    objectClass: row.objectClass,
    opType: row.opType,
    priority: row.priority,
    laneKey: row.laneKey,
    uid: row.uid,
    nameAttrValue: row.nameAttrValue,
    attrs: row.attrs,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    idempotencyKey: row.idempotencyKey,
  };
}

function extractUid(result: unknown): string | null {
  if (result && typeof result === "object" && "uid" in result) {
    const uid = (result as { uid: unknown }).uid;
    if (typeof uid === "string") return uid;
  }
  return null;
}
