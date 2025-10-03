import { Pool as TarnPool } from "tarn";
export function makePool(create, destroy, validate, opts) {
    const options = {
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
    const _pool = new TarnPool(options);
    return {
        _pool,
        acquire: () => _pool.acquire().promise,
        release: (r) => _pool.release(r),
        destroy: (r) => _pool.destroy(r),
        destroyAll: () => _pool.destroy(),
    };
}
