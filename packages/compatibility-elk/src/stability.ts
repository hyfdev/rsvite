import type { BrowserEvent, BrowserPage } from "@rsvite/compatibility-runner";

const DEFAULT_POLL_MS = 200;
const DEFAULT_QUIET_OBSERVATIONS = 10;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface StabilityOptions {
  readonly pollMs?: number;
  readonly quietObservations?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface ColdPhase {
  readonly cacheState: "warm";
  readonly events: readonly BrowserEvent[];
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("the wait was aborted"),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("the wait was aborted"));
    };
    function done(): void {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Drains the page until a bounded number of consecutive empty observations, then returns
 * everything seen before that quiet streak. Events that arrive afterwards stay on the page
 * for acceptance. Stability is the empty streak, not a fixed sleep.
 */
export async function waitForObservedStability(
  page: BrowserPage,
  signal: AbortSignal,
  options: StabilityOptions = {},
): Promise<BrowserEvent[]> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const quietNeeded = options.quietObservations ?? DEFAULT_QUIET_OBSERVATIONS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const collected: BrowserEvent[] = [];
  let quiet = 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("the wait was aborted");
    }
    const batch = page.drainEvents();
    collected.push(...batch);
    quiet = batch.length === 0 ? quiet + 1 : 0;
    if (quiet >= quietNeeded) return collected;
    await sleep(pollMs, signal);
  }

  throw new Error("ELK page did not reach a stable state after cold optimize-deps");
}

export function summarizeColdPhase(events: readonly BrowserEvent[]): {
  phase: "cold-optimize-deps";
  eventCount: number;
  mainFrameNavigations: number;
  errors: readonly BrowserEvent[];
} {
  return {
    phase: "cold-optimize-deps",
    eventCount: events.length,
    mainFrameNavigations: events.filter((event) => event.type === "main-frame-navigated").length,
    errors: events.filter((event) => event.type !== "main-frame-navigated"),
  };
}
