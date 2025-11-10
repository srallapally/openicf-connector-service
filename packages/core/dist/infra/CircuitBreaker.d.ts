type Fn<T> = () => Promise<T>;
export declare class CircuitBreaker {
    private opts;
    private state;
    private failures;
    private successes;
    private openedAt;
    private inflight;
    constructor(opts?: {
        failureThreshold: number;
        successThreshold: number;
        halfOpenAfterMs: number;
        maxConcurrent: number;
        timeoutMs: number;
    });
    exec<T>(fn: Fn<T>): Promise<T>;
    private onSuccess;
    private onFailure;
    private open;
    private close;
}
export {};
//# sourceMappingURL=CircuitBreaker.d.ts.map