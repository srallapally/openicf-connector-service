import { Pool as TarnPool } from "tarn";

export interface Pooled<T> {
  /**
   * Take a resource from the pool.
   *
   * `timeoutMillis` overrides the pool's configured acquire timeout for this
   * one call, so a caller working against a deadline can wait for the shorter
   * of "a connection frees up" and "my budget runs out" instead of blocking
   * past the point anyone is still waiting for the answer.
   */
  acquire(timeoutMillis?: number): Promise<T>;
  release(resource: T): void;
  destroy(resource: T): void;
  destroyAll(): Promise<void>;
  /** Resources currently checked out and idle, for metrics. */
  stats(): { used: number; free: number; pendingAcquires: number };
}

/** Thrown when a per-call acquire budget expires before a resource frees up. */
export class PoolAcquireTimeoutError extends Error {
  constructor(timeoutMillis: number) {
    super(`Timed out after ${timeoutMillis}ms waiting for a pooled connection`);
    this.name = "PoolAcquireTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// Minimal runtime-compatible options shape (works across tarn v2/v3)
type PoolOptionsLike<T> = {
  create: () => Promise<T>;
  destroy: (r: T) => Promise<void>;
  validate?: (r: T) => Promise<boolean>;
  min?: number;
  max?: number;
  acquireTimeoutMillis?: number;
  idleTimeoutMillis?: number;
};

export function makePool<T>(
    create: () => Promise<T>,
    destroy: (r: T) => Promise<void>,
    validate?: (r: T) => Promise<boolean>,
    opts?: Partial<PoolOptionsLike<T>>
): Pooled<T> & { _pool: any } {
  const options: PoolOptionsLike<T> = {
    create,
    destroy,
    validate: validate ?? (async () => true),
    min: 0,
    max: 10,
    acquireTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...opts,
  };

  // Keep typings stable regardless of tarn’s published .d.ts
  const _pool = new (TarnPool as any)(options as any);

  return {
    _pool,

    acquire: (timeoutMillis?: number): Promise<T> => {
      const request = _pool.acquire();
      if (timeoutMillis === undefined || !Number.isFinite(timeoutMillis)) {
        return request.promise;
      }
      if (timeoutMillis <= 0) {
        request.abort();
        return Promise.reject(new PoolAcquireTimeoutError(0));
      }

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          // Abort the pending request rather than just abandoning it: an
          // un-aborted request keeps its place in tarn's queue and would be
          // handed a connection nobody is waiting for.
          request.abort();
          reject(new PoolAcquireTimeoutError(timeoutMillis));
        }, timeoutMillis);

        request.promise.then(
            (r: T) => { clearTimeout(timer); resolve(r); },
            (e: unknown) => { clearTimeout(timer); reject(e); },
        );
      });
    },

    release: (r: T) => _pool.release(r),
    destroy: (r: T) => _pool.destroy(r),
    destroyAll: () => _pool.destroy(),
    stats: () => ({
      used: _pool.numUsed?.() ?? 0,
      free: _pool.numFree?.() ?? 0,
      pendingAcquires: _pool.numPendingAcquires?.() ?? 0,
    }),
  };
}
