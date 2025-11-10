import { LRUCache } from "lru-cache";

// If your code stores mixed shapes, use `any` for the value type to avoid constraint errors
export type Cache = LRUCache<string, any>;

export function makeCache(): Cache {
  return new LRUCache<string, any>({
    max: 10_000,
    ttl: 60_000,
    allowStale: false,
  });
}