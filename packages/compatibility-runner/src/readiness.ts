import { deadline, sleep, timer, type Deadline } from "./deadline.ts";
import type { StartedCommand } from "./process.ts";

/** Readiness exactly as the corpus manifest declares it. */
export type ReadinessSpec =
  | {
      readonly type: "http-ready";
      readonly urlPath: string;
      readonly expectStatus?: number;
      readonly timeoutMs: number;
    }
  | { readonly type: "stdout-pattern"; readonly pattern: string; readonly timeoutMs: number }
  | { readonly type: "process-exit"; readonly timeoutMs: number };

export interface ReadinessOutcome {
  readonly ready: boolean;
  /** Why readiness was not reached, for the record rather than for a thrown error. */
  readonly reason?: string;
}

const POLL_INTERVAL_MS = 100;

/** Resolves when the enclosing budget gives up, so a wait cannot outlive the phase it is in. */
function aborted(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

/**
 * An upper bound on one probe. The bound actually used is the smallest of this, the readiness
 * time left, and the lifecycle time left. A fixed cap larger than the declared readiness timeout
 * would let a server that accepts a connection and never answers outlive the very deadline it is
 * being measured against.
 */
const PROBE_CAP_MS = 1_000;

/**
 * Waits for the signal the manifest declares, inside the lifecycle budget. A command that dies
 * while being waited on is reported as not ready rather than polled until the timeout, so a
 * crash is never filed as a slow start.
 */
export async function waitForReadiness(
  spec: ReadinessSpec,
  command: StartedCommand,
  origin: string | undefined,
  lifecycle?: AbortSignal,
): Promise<ReadinessOutcome> {
  const bound = deadline(spec.timeoutMs, lifecycle);
  try {
    return await waitBounded(spec, command, origin, bound, lifecycle);
  } finally {
    bound.dispose();
  }
}

async function waitBounded(
  spec: ReadinessSpec,
  command: StartedCommand,
  origin: string | undefined,
  bound: Deadline,
  lifecycle: AbortSignal | undefined,
): Promise<ReadinessOutcome> {
  if (spec.type === "process-exit") {
    const expiry = timer(spec.timeoutMs, "timeout" as const);
    let outcome: "exited" | "timeout" | "aborted";
    try {
      // The lifecycle signal, not the derived bound: both expire together when this spec's
      // own timeout is the shorter one, and the reason has to name the right budget.
      outcome = await Promise.race([
        command.exited.then(() => "exited" as const),
        expiry.promise,
        ...(lifecycle === undefined ? [] : [aborted(lifecycle)]),
      ]);
    } finally {
      expiry.cancel();
    }
    if (outcome === "exited") return { ready: true };
    return {
      ready: false,
      reason:
        outcome === "aborted"
          ? "the lifecycle budget passed before the command exited"
          : `the command did not exit within ${String(spec.timeoutMs)}ms`,
    };
  }

  let exited = false;
  void command.exited.then(() => {
    exited = true;
  });

  while (!bound.expired()) {
    if (await isReady(spec, origin, command, bound.remaining())) return { ready: true };
    if (exited) {
      return { ready: false, reason: "the command exited before it reported readiness" };
    }
    await sleep(Math.min(POLL_INTERVAL_MS, bound.remaining()), bound.signal);
  }

  return { ready: false, reason: `readiness was not reached within ${String(spec.timeoutMs)}ms` };
}

async function isReady(
  spec: Exclude<ReadinessSpec, { type: "process-exit" }>,
  origin: string | undefined,
  command: StartedCommand,
  remainingMs: number,
): Promise<boolean> {
  if (spec.type === "stdout-pattern") {
    return new RegExp(spec.pattern).test(command.readStdout());
  }

  if (origin === undefined) {
    throw new Error("http-ready needs the origin the command serves on");
  }

  try {
    const response = await fetch(new URL(spec.urlPath, origin), {
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1, Math.min(PROBE_CAP_MS, remainingMs))),
    });
    // The body is never read, so the socket is released rather than held open.
    await response.body?.cancel();
    return response.status === (spec.expectStatus ?? 200);
  } catch {
    // A refused connection, a reset, and a probe that ran out of time all mean "not ready yet".
    return false;
  }
}
