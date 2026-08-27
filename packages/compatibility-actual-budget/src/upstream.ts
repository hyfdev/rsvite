import { startCommand, type CommandOutcome, type CommandSpec } from "@rsvite/compatibility-runner";

/** A command this adapter runs outside the runner's own lifecycle, under its own budget. */
export interface UpstreamStep {
  /** How the step is named in a failure, in the reader's words rather than in argv. */
  readonly label: string;
  readonly command: CommandSpec;
  readonly timeoutMs: number;
  readonly logs?: { readonly stdout: string; readonly stderr: string };
}

export type BoundEnd = "exited" | "timed-out" | "abandoned";

export interface UpstreamRun {
  readonly end: BoundEnd;
  readonly outcome: CommandOutcome;
  /** Why this step is not usable evidence, if it is not. */
  readonly problem?: string;
}

/**
 * Waits for `work`, for the budget, or for the caller giving up — whichever comes first.
 *
 * The clock decides lateness, not the timer callback: work that holds the event loop past the
 * budget and then resolves would deliver its microtask before the delayed timer ever ran, and a
 * step that took twice its budget would be reported as having finished in time.
 */
async function awaitBound(
  work: Promise<unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<BoundEnd> {
  const expiresAt = Date.now() + timeoutMs;
  let expiry: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const end = await Promise.race<BoundEnd>([
      work.then(
        () => "exited" as const,
        () => "exited" as const,
      ),
      new Promise<BoundEnd>((resolve) => {
        expiry = setTimeout(() => resolve("timed-out"), timeoutMs);
      }),
      new Promise<BoundEnd>((resolve) => {
        if (signal === undefined) return;
        if (signal.aborted) {
          resolve("abandoned");
          return;
        }
        onAbort = (): void => resolve("abandoned");
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    return end === "exited" && Date.now() >= expiresAt ? "timed-out" : end;
  } finally {
    if (expiry !== undefined) clearTimeout(expiry);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

function describeEnd(
  step: UpstreamStep,
  end: BoundEnd,
  outcome: CommandOutcome,
): string | undefined {
  // A command that never started did not run out of time; it failed to exist, and saying
  // otherwise sends a reader looking for output nothing ever produced.
  if (outcome.startError !== undefined)
    return `${step.label} could not start: ${outcome.startError}`;
  if (end === "abandoned") return `${step.label} was abandoned before it finished`;
  if (end === "timed-out") return `${step.label} did not finish within ${String(step.timeoutMs)}ms`;
  if (outcome.exitCode !== 0) {
    return `${step.label} exited with code ${String(outcome.exitCode)}${
      outcome.signal === null ? "" : ` after ${outcome.signal}`
    }`;
  }
  return undefined;
}

/**
 * Runs one upstream command under a budget the caller can also end early.
 *
 * Nothing here may outlive the run that started it. The project's own spec starts a browser and
 * its build starts workers, so ending the leader is not enough — the group is stopped on every
 * path, including the one where the caller gave up while the command was still working.
 */
export async function runUpstream(step: UpstreamStep, signal?: AbortSignal): Promise<UpstreamRun> {
  const started = startCommand(step.command, step.logs);
  const end = await awaitBound(started.exited, step.timeoutMs, signal);
  const outcome = await started.stop();
  const problem = describeEnd(step, end, outcome);
  return problem === undefined
    ? { end, outcome: { ...outcome, timedOut: end === "timed-out" } }
    : { end, outcome: { ...outcome, timedOut: end === "timed-out" }, problem };
}

/** Runs a step and raises its problem, for callers whose next action depends on it having run. */
export async function runUpstreamOrThrow(step: UpstreamStep, signal?: AbortSignal): Promise<void> {
  const run = await runUpstream(step, signal);
  if (run.problem !== undefined) throw new Error(run.problem);
}
