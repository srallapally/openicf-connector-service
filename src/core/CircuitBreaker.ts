type Fn<T> = () => Promise<T>;

export class CircuitBreaker {
  private state: "CLOSED" | "OPEN" | "HALF" = "CLOSED";
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private inflight = 0;

  constructor(
    private opts = {
      failureThreshold: 5,
      successThreshold: 2,
      halfOpenAfterMs: 10_000,
      maxConcurrent: 20,
      timeoutMs: 30_000
    }
  ) {}

  async exec<T>(fn: Fn<T>): Promise<T> {
    const now = Date.now();
    if (this.state === "OPEN" && now - this.openedAt > this.opts.halfOpenAfterMs) {
      this.state = "HALF"; this.failures = 0; this.successes = 0;
    }
    if (this.state === "OPEN") throw new Error("CircuitOpen");
    if (this.inflight >= this.opts.maxConcurrent) throw new Error("TooManyRequests");

    this.inflight++;
    let timer: any = null;
    try {
      const res = await Promise.race([
        fn(),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("BreakerTimeout")), this.opts.timeoutMs); })
      ]);
      this.onSuccess();
      return res;
    } catch (e) {
      this.onFailure();
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      this.inflight--;
    }
  }

  private onSuccess() {
    if (this.state === "HALF") {
      this.successes++;
      if (this.successes >= this.opts.successThreshold) this.close();
    } else {
      this.failures = 0;
    }
  }
  private onFailure() {
    if (this.state === "HALF") { this.open(); return; }
    this.failures++;
    if (this.failures >= this.opts.failureThreshold) this.open();
  }
  private open() { this.state = "OPEN"; this.openedAt = Date.now(); }
  private close() { this.state = "CLOSED"; this.failures = 0; this.successes = 0; }
}
