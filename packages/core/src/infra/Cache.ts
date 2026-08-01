import { LRUCache } from "lru-cache";

// If your code stores mixed shapes, use `any` for the value type to avoid constraint errors
export type Cache = LRUCache<string, any>;

export interface CacheOptions {
  /** Maximum entries before least-recently-used eviction. */
  max?: number | undefined;
  /** Entry lifetime in milliseconds. */
  ttl?: number | undefined;
}

/**
 * Build an LRU cache.
 *
 * Sized by the caller because the right size is workload-specific: a facade
 * with opt-in read caching wants a small bounded cache per instance, not the
 * 10k-entry default that used to be allocated whether or not anything was
 * cached.
 */
export function makeCache(opts: CacheOptions = {}): Cache {
  return new LRUCache<string, any>({
    max: opts.max ?? 10_000,
    ttl: opts.ttl ?? 60_000,
    allowStale: false,
  });
}