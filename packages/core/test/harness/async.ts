// test/harness/async.ts
//
// Primitives for scripting deterministic interleavings. Nothing here sleeps:
// a test that needs two operations to overlap says so explicitly rather than
// hoping a timeout is long enough.

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  /** True once resolve or reject has been called. */
  readonly settled: boolean;
}

/** A promise with its resolvers exposed. */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let settled = false;

  const promise = new Promise<T>((res, rej) => {
    resolve = (value: T) => { settled = true; res(value); };
    reject = (error: unknown) => { settled = true; rej(error); };
  });

  return {
    promise,
    resolve: (v) => resolve(v),
    reject: (e) => reject(e),
    get settled() { return settled; },
  };
}

/**
 * A reusable meeting point for N parties.
 *
 * `arrive()` resolves only once every party has arrived, which is how a test
 * forces two callers into the same critical section: both arrive before either
 * proceeds, so any check-then-act window is guaranteed to be open when the
 * second caller enters it.
 */
export function barrier(parties: number): { arrive(): Promise<void>; readonly waiting: number } {
  if (parties < 1) throw new Error("barrier needs at least one party");

  let waiting = 0;
  let gate = deferred<void>();

  return {
    get waiting() { return waiting; },
    arrive(): Promise<void> {
      waiting++;
      const current = gate;
      if (waiting >= parties) {
        waiting = 0;
        gate = deferred<void>();
        current.resolve();
      }
      return current.promise;
    },
  };
}

/**
 * Yield to the microtask queue `times` over.
 *
 * Used to let already-resolved promise chains drain without advancing fake
 * timers, so a test can assert "nothing further happened" rather than "nothing
 * happened yet".
 */
export async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Resolve when `predicate` holds, draining microtasks between checks. */
export async function until(predicate: () => boolean, maxTicks = 100): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`condition did not hold within ${maxTicks} microtask ticks`);
}
