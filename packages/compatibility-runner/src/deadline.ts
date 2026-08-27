/**
 * One cancellable deadline primitive for the whole runner. Layering independent races was the
 * previous mistake twice over: each layer kept its own timer alive after it lost, and none of
 * them could tell the work below to stop.
 */

/**
 * The work was still running after its deadline passed and it was aborted. The adapter contract
 * requires every asynchronous entry point to settle once its signal is aborted; work that does
 * not is left driving something the run can no longer see, so the run fails loudly rather than
 * recording a result while that continues.
 */
export class AbandonedWorkError extends Error {
  constructor(what: string, cleanupMs: number) {
    super(
      `${what} did not settle within ${String(cleanupMs)}ms of being aborted, violating the abort-settle contract`,
    );
    this.name = "AbandonedWorkError";
  }
}

/** A sleep whose timer is always cleared, so a completed race never holds the host open. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      finish();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
  });
}

/**
 * A timer that can be cancelled by the side that wins the race. `sleep` only clears itself when
 * it resolves or when its signal aborts, so the loser of a `Promise.race` would otherwise keep
 * a live timer — and an idle host — until it fired.
 */
export function timer<T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } {
  let cancel = (): void => undefined;
  const promise = new Promise<T>((resolve) => {
    const handle = setTimeout(() => resolve(value), ms);
    cancel = (): void => {
      clearTimeout(handle);
    };
  });
  return { promise, cancel: () => cancel() };
}

export interface Deadline {
  /** Aborted when this deadline passes, or when the deadline it was derived from does. */
  readonly signal: AbortSignal;
  /** Milliseconds left, never below zero. */
  remaining(): number;
  expired(): boolean;
  /** Ends the budget early, for a reason the clock cannot know about. */
  abort(reason: Error): void;
  /** Releases the timer. A deadline that is not disposed keeps the host alive until it fires. */
  dispose(): void;
}

/**
 * A deadline of `ms`, optionally nested inside `parent`. Nesting is what lets one lifecycle
 * budget bound every step underneath it: the child cannot outlive the parent, and expiry of
 * either one aborts the same work.
 */
export function deadline(ms: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  const expiresAt = Date.now() + ms;

  const timer = setTimeout(() => {
    controller.abort(new Error(`deadline of ${String(ms)}ms passed`));
  }, ms);

  const onParentAbort = (): void => {
    controller.abort(parent?.reason);
  };
  if (parent !== undefined) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    remaining: () => Math.max(0, expiresAt - Date.now()),
    // The clock, not the timer callback. Work that blocks the event loop past the budget and
    // then resolves would otherwise deliver its microtask before the delayed timer ever ran,
    // and a run that took 600ms under a 100ms budget would be reported as a pass.
    expired: () => controller.signal.aborted || Date.now() >= expiresAt,
    abort: (reason) => controller.abort(reason),
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

export type Bounded<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: string;
      /**
       * The deadline ended it, rather than the work failing on its own. A timeout is decided by
       * the clock at the moment it passes; an ordinary rejection happened after whatever the
       * work had already reported, and the two rank differently against other evidence.
       */
      readonly timedOut?: boolean;
      /**
       * A value the work produced after its deadline passed. The operation obeyed the contract
       * and settled on abort, so whatever it produced still needs releasing — dropping it is
       * how a browser page survives the run that gave up on it.
       */
      readonly late?: T;
    };

/**
 * Runs `start` under `bound`. On expiry the work is aborted and then awaited: the runner does
 * not move on — and must never record a result — while an operation it abandoned is still
 * driving something in the background. Work that ignores the abort raises rather than being
 * silently left behind.
 */
export async function runUnder<T>(
  start: (signal: AbortSignal) => Promise<T>,
  bound: Deadline,
  what: string,
  cleanupMs: number,
): Promise<Bounded<T>> {
  // The callback may throw before it returns a Promise; a function that satisfies the interface
  // is still allowed to fail synchronously, and that has to become the same classified failure
  // as a rejection rather than escaping the wrapper.
  const invoked = (async () => start(bound.signal))();
  const settled = invoked.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, reason: `${what} failed: ${String(error)}` }),
  );

  const expiry = new Promise<"expired">((resolve) => {
    if (bound.signal.aborted) {
      resolve("expired");
      return;
    }
    bound.signal.addEventListener("abort", () => resolve("expired"), { once: true });
  });

  const first = await Promise.race([settled, expiry]);
  if (first !== "expired") {
    // Settling is not the same as being on time. Synchronous work cannot be preempted, so the
    // only honest check is whether the budget had already passed by the time it finished.
    if (!bound.expired()) return first;
    const reason = `${what} did not finish within its deadline`;
    return first.ok
      ? { ok: false, reason, timedOut: true, late: first.value }
      : { ok: false, reason, timedOut: true };
  }

  const grace = timer(cleanupMs, "abandoned" as const);
  let outcome: Awaited<typeof settled> | "abandoned";
  try {
    outcome = await Promise.race([settled, grace.promise]);
  } finally {
    grace.cancel();
  }
  if (outcome === "abandoned") throw new AbandonedWorkError(what, cleanupMs);

  const reason = `${what} did not finish within its deadline`;
  // The work obeyed the contract and produced something after the deadline. Handing it back is
  // what lets the caller release it; dropping it is how a browser page survives the run.
  return outcome.ok
    ? { ok: false, reason, timedOut: true, late: outcome.value }
    : { ok: false, reason, timedOut: true };
}
