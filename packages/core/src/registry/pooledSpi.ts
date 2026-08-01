// src/registry/pooledSpi.ts
//
// Presents a pool of connector instances as a single ConnectorSpi.
//
// Only connectors whose manifest declares `poolable` go through here. Those
// hold a stateful protocol connection -- LDAP, SQL, SSH -- where concurrency
// means more connections, not more requests down one. A REST connector gains
// nothing from this and gets an HTTP keep-alive agent instead.

import type { ConnectorSpi, OperationOptions } from "../spi/types.js";
import { makePool, type Pooled } from "../infra/Pool.js";

/** SPI members that are data, not behaviour, and must be visible on the proxy. */
const FLAG_KEYS = ["searchStreaming"] as const;

/**
 * Methods proxied through the pool.
 *
 * `dispose` is excluded on purpose: disposing the proxy must drain the pool,
 * not destroy one borrowed resource. `schema` is included because a connector
 * may need its connection to answer it.
 */
const POOLED_METHODS = [
  "create", "update", "delete", "get", "search", "sync",
  "test", "schema", "scriptOnConnector", "scriptOnResource",
  "addAttributeValues", "removeAttributeValues",
  "resolveUsername", "authenticate", "validateConfiguration",
] as const;

export interface PooledSpiOptions {
  /** Upper bound on live connections. Defaults to the two concurrency budgets summed. */
  max: number;
  /** Baseline acquire budget when a call carries no deadline. Default 5000ms. */
  acquireTimeoutMillis?: number | undefined;
  /** How long an unused connection lingers. Default 60000ms. */
  idleTimeoutMillis?: number | undefined;
}

export interface PooledSpi {
  spi: ConnectorSpi;
  pool: Pooled<ConnectorSpi>;
}

/**
 * Find the OperationOptions among a call's arguments.
 *
 * Positional scanning rather than a fixed index because `search` takes options
 * third or fourth depending on whether a ResultsHandler is present.
 */
function findOptions(args: unknown[]): OperationOptions | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (a && typeof a === "object" && !Array.isArray(a) && typeof a !== "function") {
      const o = a as OperationOptions;
      if (o.deadlineEpochMs !== undefined || o.abortSignal !== undefined) return o;
    }
  }
  return undefined;
}

/**
 * Build a pooled SPI.
 *
 * `create` is called lazily by tarn, so nothing connects until the first
 * operation. One resource is acquired up front only to learn the connector's
 * shape -- which methods exist, and the value of flags like `searchStreaming`
 * -- and is returned to the pool immediately.
 */
export async function makePooledSpi(
    createSpi: () => Promise<ConnectorSpi>,
    opts: PooledSpiOptions,
): Promise<PooledSpi> {
  const acquireTimeoutMillis = opts.acquireTimeoutMillis ?? 5_000;

  const pool = makePool<ConnectorSpi>(
      createSpi,
      async (resource) => { await (resource as { dispose?: () => Promise<void> }).dispose?.(); },
      async (resource) => {
        // A connection the target has since dropped must not be handed out.
        const t = (resource as { test?: () => Promise<void> }).test;
        if (!t) return true;
        try { await t.call(resource); return true; } catch { return false; }
      },
      {
        min: 0,
        max: opts.max,
        acquireTimeoutMillis,
        idleTimeoutMillis: opts.idleTimeoutMillis ?? 60_000,
      },
  );

  const probe = await pool.acquire();
  const shape: Record<string, unknown> = {};
  for (const flag of FLAG_KEYS) {
    shape[flag] = (probe as Record<string, unknown>)[flag];
  }
  const present = POOLED_METHODS.filter(
      name => typeof (probe as Record<string, unknown>)[name] === "function",
  );
  pool.release(probe);

  const spi: Record<string, unknown> = { ...shape };

  for (const name of present) {
    spi[name] = async (...args: unknown[]) => {
      const options = findOptions(args);
      // Wait for the shorter of the configured budget and whatever remains of
      // this attempt's deadline. Blocking past the deadline would hold the
      // caller for an answer it has already stopped waiting for.
      const remaining = options?.deadlineEpochMs === undefined
          ? Infinity
          : options.deadlineEpochMs - Date.now();
      const budget = Math.min(acquireTimeoutMillis, remaining);

      const resource = await pool.acquire(budget);
      try {
        const fn = (resource as Record<string, unknown>)[name] as (...a: unknown[]) => unknown;
        return await fn.apply(resource, args);
      } finally {
        // Always returned, including on failure: a connector that threw is
        // still a usable connection, and `validate` screens it on the way out
        // if the target really did drop it.
        pool.release(resource);
      }
    };
  }

  spi["dispose"] = async () => { await pool.destroyAll(); };

  return { spi: spi as unknown as ConnectorSpi, pool };
}
