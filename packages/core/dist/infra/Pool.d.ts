export interface Pooled<T> {
    acquire(): Promise<T>;
    release(resource: T): void;
    destroy(resource: T): void;
    destroyAll(): Promise<void>;
}
type PoolOptionsLike<T> = {
    create: () => Promise<T>;
    destroy: (r: T) => Promise<void>;
    validate?: (r: T) => Promise<boolean>;
    min?: number;
    max?: number;
    acquireTimeoutMillis?: number;
    idleTimeoutMillis?: number;
};
export declare function makePool<T>(create: () => Promise<T>, destroy: (r: T) => Promise<void>, validate?: (r: T) => Promise<boolean>, opts?: Partial<PoolOptionsLike<T>>): Pooled<T> & {
    _pool: any;
};
export {};
//# sourceMappingURL=Pool.d.ts.map