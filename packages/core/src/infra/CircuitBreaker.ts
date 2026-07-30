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

    let p: Promise<T>;
    try {
      p = fn();
    } catch (e) {
      // fn threw synchronously: no promise ever existed, so nothing else will
      // release the slot.
      this.inflight--;
      this.onFailure();
      throw e;
    }

    // The slot is held until the underlying work settles, not until the race
    // settles. A timeout abandons the result but the operation is still
    // running, and maxConcurrent is meant to bound outstanding work.
    //
    // then(release, release) rather than finally(release): finally returns a
    // new promise that rejects when p rejects, and nothing would handle it,
    // creating an unhandled rejection this code does not currently have.
    const release = () => { this.inflight--; };
    p.then(release, release);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("BreakerTimeout")), this.opts.timeoutMs);
      });

      const res = await Promise.race([p, timeoutPromise]);
      this.onSuccess();
      return res;
    } catch (e) {
      this.onFailure();
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // No decrement here: release() owns it.
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
