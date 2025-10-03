export class CircuitBreaker {
    opts;
    state = "CLOSED";
    failures = 0;
    successes = 0;
    openedAt = 0;
    inflight = 0;
    constructor(opts = {
        failureThreshold: 5,
        successThreshold: 2,
        halfOpenAfterMs: 10_000,
        maxConcurrent: 20,
        timeoutMs: 30_000
    }) {
        this.opts = opts;
    }
    async exec(fn) {
        const now = Date.now();
        if (this.state === "OPEN" && now - this.openedAt > this.opts.halfOpenAfterMs) {
            this.state = "HALF";
            this.failures = 0;
            this.successes = 0;
        }
        if (this.state === "OPEN")
            throw new Error("CircuitOpen");
        if (this.inflight >= this.opts.maxConcurrent)
            throw new Error("TooManyRequests");
        this.inflight++;
        let timer = null;
        try {
            const res = await Promise.race([
                fn(),
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("BreakerTimeout")), this.opts.timeoutMs); })
            ]);
            this.onSuccess();
            return res;
        }
        catch (e) {
            this.onFailure();
            throw e;
        }
        finally {
            if (timer)
                clearTimeout(timer);
            this.inflight--;
        }
    }
    onSuccess() {
        if (this.state === "HALF") {
            this.successes++;
            if (this.successes >= this.opts.successThreshold)
                this.close();
        }
        else {
            this.failures = 0;
        }
    }
    onFailure() {
        if (this.state === "HALF") {
            this.open();
            return;
        }
        this.failures++;
        if (this.failures >= this.opts.failureThreshold)
            this.open();
    }
    open() { this.state = "OPEN"; this.openedAt = Date.now(); }
    close() { this.state = "CLOSED"; this.failures = 0; this.successes = 0; }
}
