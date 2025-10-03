import { Pool as TarnPool } from "tarn";

export interface Pooled<T> {
  acquire(): Promise<T>;
  release(resource: T): void;
  destroy(resource: T): void;
  destroyAll(): Promise<void>;
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
    acquire: () => _pool.acquire().promise,
    release: (r: T) => _pool.release(r),
    destroy: (r: T) => _pool.destroy(r),
    destroyAll: () => _pool.destroy(),
  };
}
