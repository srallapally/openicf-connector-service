// src/ops/OperationStore.ts
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { OperationOutcome, OperationPriority, OperationStatus } from "../spi/types.js";

/** Absolute path to the DDL that backs this store. */
export const OPERATIONS_SCHEMA_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "schema.sql",
);

/** Mutation kinds the operation table records. Reads are synchronous and never enqueued. */
export type OperationType = "CREATE" | "UPDATE" | "DELETE";

const TERMINAL_STATUSES: readonly OperationOutcome[] = [
  "SUCCEEDED",
  "REJECTED_PRE_DISPATCH",
  "FAILED_CONFIRMED",
  "INDETERMINATE",
];

export interface EnqueueInput {
  instanceId: string;
  objectClass: string;
  opType: OperationType;
  /** Serialization key; operations sharing one never run concurrently on an instance. */
  laneKey: string;
  /** Caller-supplied dedup key. Re-enqueueing the same key returns the original id. */
  idempotencyKey: string;
  priority?: OperationPriority | undefined;
  uid?: string | null | undefined;
  nameAttrValue?: string | null | undefined;
  attrs?: Record<string, unknown> | null | undefined;
}

export interface EnqueueResult {
  id: string;
  /** True when an existing operation with this idempotency key was returned instead of inserting. */
  deduplicated: boolean;
}

export interface ClaimedOperation {
  id: string;
  instanceId: string;
  objectClass: string;
  opType: OperationType;
  priority: OperationPriority;
  laneKey: string;
  uid: string | null;
  nameAttrValue: string | null;
  attrs: Record<string, unknown> | null;
  attemptCount: number;
  createdAt: Date;
  idempotencyKey: string;
}

export interface OperationStatusRow {
  id: string;
  instanceId: string;
  objectClass: string;
  opType: OperationType;
  status: OperationStatus;
  attemptCount: number;
  result: unknown | null;
  errorCode: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
  /** True when the row came from operations_history because the hot row has aged out. */
  fromHistory: boolean;
}

export interface PendingCounts {
  interactive: number;
  batch: number;
}

/**
 * Derive a stable 64-bit advisory lock key from an idempotency key.
 *
 * Taken from a SHA-256 digest rather than a database-side hash so the value
 * depends only on documented APIs. Collisions are possible and harmless: two
 * unrelated keys sharing a lock serialize against each other briefly, which
 * costs a little concurrency and changes no outcome.
 */
function advisoryLockKey(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest().readBigInt64BE(0).toString();
}

const CLAIM_SQL = `
WITH caps AS (
    SELECT * FROM unnest($1::text[], $2::int[]) AS t(instance_id, cap)
),
ranked AS (
    SELECT o.id,
           o.created_at,
           o.priority,
           row_number() OVER (
               PARTITION BY o.instance_id
               ORDER BY (o.priority = 'interactive') DESC, o.created_at
           ) AS rn,
           c.cap
    FROM operations o
    JOIN caps c ON c.instance_id = o.instance_id
    WHERE o.status = 'PENDING'
      AND NOT (o.lane_key = ANY($3::text[]))
),
picked AS (
    SELECT id, created_at
    FROM ranked
    WHERE rn <= cap
    ORDER BY (priority = 'interactive') DESC, created_at
    LIMIT $4
),
locked AS (
    SELECT o.id, o.created_at
    FROM operations o
    JOIN picked p ON p.id = o.id AND p.created_at = o.created_at
    WHERE o.status = 'PENDING'
    FOR UPDATE OF o SKIP LOCKED
)
UPDATE operations o
SET status = 'RUNNING',
    claimed_at = now()
FROM locked l
WHERE o.id = l.id AND o.created_at = l.created_at
RETURNING o.id, o.instance_id, o.object_class, o.op_type, o.priority, o.lane_key,
          o.uid, o.name_attr_value, o.attrs, o.attempt_count, o.created_at, o.idempotency_key
`;

/**
 * Durable store for asynchronous mutations.
 *
 * Takes a `pg.Pool` and never creates one: pool sizing belongs to the process
 * that owns the deployment, and the dispatcher wants its own small pool sized
 * against its claim concurrency rather than a share of the application's.
 *
 * Every statement is parameterized. No identifier or value is interpolated
 * into SQL text anywhere in this class.
 */
export class OperationStore {
  constructor(private readonly pool: Pool) {}

  /** Apply the DDL. Idempotent; safe to run on every boot. */
  static schemaPath(): string {
    return OPERATIONS_SCHEMA_PATH;
  }

  /**
   * Insert a PENDING operation, or return the id of the existing operation
   * carrying the same idempotency key.
   *
   * Serialized on a transaction-scoped advisory lock rather than a unique
   * constraint. A partitioned table can only enforce uniqueness on a key that
   * includes the partition column, and (idempotency_key, created_at) collides
   * only on an identical timestamp -- which never happens and would enforce
   * nothing if it did. The advisory lock gives the guarantee the unique index
   * cannot, and it is released with the transaction whether it commits or not.
   */
  async enqueue(op: EnqueueInput): Promise<EnqueueResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        advisoryLockKey(op.idempotencyKey),
      ]);

      const existing = await client.query(
          `SELECT id FROM operations WHERE idempotency_key = $1 ORDER BY created_at DESC LIMIT 1`,
          [op.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior) {
        await client.query("COMMIT");
        return { id: String(prior.id), deduplicated: true };
      }

      const inserted = await client.query(
          `INSERT INTO operations
               (instance_id, object_class, op_type, priority, lane_key,
                uid, name_attr_value, attrs, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            op.instanceId,
            op.objectClass,
            op.opType,
            op.priority ?? "batch",
            op.laneKey,
            op.uid ?? null,
            op.nameAttrValue ?? null,
            op.attrs === undefined || op.attrs === null ? null : JSON.stringify(op.attrs),
            op.idempotencyKey,
          ],
      );
      await client.query("COMMIT");

      const row = inserted.rows[0];
      if (!row) throw new Error("enqueue: insert returned no row");
      return { id: String(row.id), deduplicated: false };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { /* the original error is the useful one */ });
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Claim up to `limit` PENDING operations and mark them RUNNING.
   *
   * `activeLaneKeys` are lanes already executing; excluding them is what keeps
   * two operations against the same object from overlapping.
   *
   * `perInstanceAvailable` caps how many rows each instance may contribute to
   * this cycle. The dispatcher computes those numbers from each instance's
   * concurrency budget and interactive slice; the cap is applied here, before
   * the UPDATE, because a row marked RUNNING and then discarded by the caller
   * would be stranded in a non-terminal state.
   *
   * Concurrent dispatchers coordinate through SKIP LOCKED alone -- no leader
   * election, no external lock. Two replicas racing the same rows simply
   * partition them.
   *
   * `attempt_count` is not incremented here; it counts requeues, so a first
   * attempt runs at 0.
   */
  async claimBatch(
      limit: number,
      activeLaneKeys: readonly string[],
      perInstanceAvailable: ReadonlyMap<string, number>,
  ): Promise<ClaimedOperation[]> {
    const instanceIds: string[] = [];
    const caps: number[] = [];
    for (const [instanceId, available] of perInstanceAvailable) {
      if (available > 0) {
        instanceIds.push(instanceId);
        caps.push(available);
      }
    }
    // Every instance is saturated or rate limited: nothing can be claimed, and
    // the query would be a guaranteed-empty scan.
    if (instanceIds.length === 0 || limit <= 0) return [];

    const res = await this.pool.query(CLAIM_SQL, [
      instanceIds,
      caps,
      activeLaneKeys,
      limit,
    ]);

    return res.rows.map((r): ClaimedOperation => ({
      id: String(r.id),
      instanceId: String(r.instance_id),
      objectClass: String(r.object_class),
      opType: r.op_type as OperationType,
      priority: r.priority as OperationPriority,
      laneKey: String(r.lane_key),
      uid: r.uid ?? null,
      nameAttrValue: r.name_attr_value ?? null,
      attrs: r.attrs ?? null,
      attemptCount: Number(r.attempt_count),
      createdAt: r.created_at as Date,
      idempotencyKey: String(r.idempotency_key),
    }));
  }

  /**
   * Move an operation to a terminal status and write its slim history row in
   * the same transaction, so a record can never reach a terminal state without
   * its permanent counterpart.
   *
   * Returns false if the operation was already terminal or does not exist --
   * a redelivered finalize is a no-op, not an error.
   *
   * The history row prefers the create result's Uid over the request's uid
   * column: on a create the target mints the Uid, and it is the one fact that
   * has to outlive the 24 hour hot window.
   */
  async finalize(
      id: string,
      outcome: OperationOutcome,
      result?: unknown,
      errorCode?: string | null,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const updated = await client.query(
          `UPDATE operations
              SET status = $2,
                  result = COALESCE($3::jsonb, result),
                  error_code = $4,
                  finalized_at = now()
            WHERE id = $1
              AND NOT (status = ANY($5::text[]))
        RETURNING id, instance_id, object_class, op_type, status, uid, error_code,
                  created_at, finalized_at, result`,
          [
            id,
            outcome,
            result === undefined ? null : JSON.stringify(result),
            errorCode ?? null,
            TERMINAL_STATUSES,
          ],
      );

      const row = updated.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return false;
      }

      await client.query(
          `INSERT INTO operations_history
               (id, instance_id, object_class, op_type, status, uid, error_code, created_at, finalized_at)
           SELECT $1, $2, $3, $4, $5, COALESCE($6, ($7::jsonb)->>'uid'), $8, $9, $10
           ON CONFLICT (id) DO NOTHING`,
          [
            row.id,
            row.instance_id,
            row.object_class,
            row.op_type,
            row.status,
            row.uid ?? null,
            row.result === null || row.result === undefined ? null : JSON.stringify(row.result),
            row.error_code ?? null,
            row.created_at,
            row.finalized_at,
          ],
      );

      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { /* the original error is the useful one */ });
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Return a RUNNING operation to PENDING for another attempt.
   *
   * Increments attempt_count, so the counter measures retries rather than
   * claims. Returns false if the operation was not RUNNING, which is what a
   * duplicate requeue looks like.
   */
  async requeue(id: string): Promise<boolean> {
    const res = await this.pool.query(
        `UPDATE operations
            SET status = 'PENDING',
                claimed_at = NULL,
                attempt_count = attempt_count + 1
          WHERE id = $1 AND status = 'RUNNING'`,
        [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * PENDING depth for one instance, split by priority class.
   *
   * Backs the admission cap: the enqueue path rejects with 429 and the backlog
   * depth once a class is over its cap, which turns queue depth into the flow
   * control signal instead of letting it grow without bound.
   */
  async pendingCounts(instanceId: string): Promise<PendingCounts> {
    const res = await this.pool.query(
        `SELECT priority, count(*)::int AS n
           FROM operations
          WHERE instance_id = $1 AND status = 'PENDING'
          GROUP BY priority`,
        [instanceId],
    );

    const counts: PendingCounts = { interactive: 0, batch: 0 };
    for (const row of res.rows) {
      if (row.priority === "interactive") counts.interactive = Number(row.n);
      else if (row.priority === "batch") counts.batch = Number(row.n);
    }
    return counts;
  }

  /**
   * Look up one operation for the status endpoint.
   *
   * Falls back to operations_history when the hot row has aged out, so a
   * caller polling an operation id past the retention window still gets its
   * outcome rather than a 404. History rows carry no payload, so `result` is
   * null there even for a success -- the Uid is reported instead.
   */
  async getStatus(id: string): Promise<OperationStatusRow | null> {
    const hot = await this.pool.query(
        `SELECT id, instance_id, object_class, op_type, status, attempt_count,
                result, error_code, created_at, finalized_at
           FROM operations
          WHERE id = $1`,
        [id],
    );

    const row = hot.rows[0];
    if (row) {
      return {
        id: String(row.id),
        instanceId: String(row.instance_id),
        objectClass: String(row.object_class),
        opType: row.op_type as OperationType,
        status: row.status as OperationStatus,
        attemptCount: Number(row.attempt_count),
        result: row.result ?? null,
        errorCode: row.error_code ?? null,
        createdAt: row.created_at as Date,
        finalizedAt: (row.finalized_at as Date | null) ?? null,
        fromHistory: false,
      };
    }

    const cold = await this.pool.query(
        `SELECT id, instance_id, object_class, op_type, status, uid, error_code,
                created_at, finalized_at
           FROM operations_history
          WHERE id = $1`,
        [id],
    );

    const histRow = cold.rows[0];
    if (!histRow) return null;

    return {
      id: String(histRow.id),
      instanceId: String(histRow.instance_id),
      objectClass: String(histRow.object_class),
      opType: histRow.op_type as OperationType,
      status: histRow.status as OperationStatus,
      attemptCount: 0,
      result: histRow.uid ? { uid: String(histRow.uid) } : null,
      errorCode: histRow.error_code ?? null,
      createdAt: histRow.created_at as Date,
      finalizedAt: (histRow.finalized_at as Date | null) ?? null,
      fromHistory: true,
    };
  }
}
