import { LRUCache } from "lru-cache";
export function makeCache() {
    return new LRUCache({
        max: 10_000,
        ttl: 60_000,
        allowStale: false,
    });
}
