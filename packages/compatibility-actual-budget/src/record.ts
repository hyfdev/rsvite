import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  runCompatibilityCheck,
  type BrowserAdapter,
  type BrowserPage,
  type CommandSpec,
  type DeclaredRunInputs,
  type LifecycleName,
  type RunEnvironment,
  type RunFailure,
  type RunReport,
  type RunRequest,
} from "@rsvite/compatibility-runner";

/**
 * The manifest one run is measured under: the same entry, describing the same pinned input, with
 * the commands that subject is driven by and the way that lifecycle reports being ready.
 *
 * The entry records the project's own commands and how its server becomes reachable. Running a
 * different implementation, or a lifecycle that finishes instead of serving, means naming that
 * here rather than editing the corpus into something the project does not declare.
 */
export function manifestForRun(
  manifest: unknown,
  entryId: string,
  overrides: {
    readonly commands: Readonly<Record<string, CommandSpec>>;
    readonly readiness?: unknown;
  },
): unknown {
  const source = manifest as { entries: { id: string }[] };
  return {
    ...source,
    entries: source.entries.map((entry) =>
      entry.id === entryId
        ? {
            ...entry,
            commands: { ...overrides.commands },
            ...(overrides.readiness === undefined ? {} : { readiness: overrides.readiness }),
          }
        : entry,
    ),
  };
}

export interface RecordRequest {
  readonly checkoutRoot: string;
  /** Already specific to this run: see `manifestForRun`. */
  readonly manifest: unknown;
  readonly entryId: string;
  readonly lifecycle: LifecycleName;
  readonly subject: RunRequest["subject"];
  readonly environment: RunEnvironment;
  readonly declared: DeclaredRunInputs;
  /** Where the accepted evidence ends up. Nothing is written here until every step has passed. */
  readonly publishRoot: string;
  /** Where this run writes while it is still allowed to fail. Replaced on every run. */
  readonly stagingRoot: string;
  readonly timeouts: RunRequest["timeouts"];
  readonly origin?: string;
  readonly browser?: BrowserAdapter;
  readonly update?: (page: BrowserPage, signal: AbortSignal) => Promise<void>;
  /**
   * Everything this recording holds fixed: the pinned checkout, and any input that lives inside
   * it but outside its history. Raises when one of them is not what the corpus records. It runs
   * before anything starts and again after everything has finished, because a run can only be
   * read as evidence about the pinned input if that is still what it was.
   */
  readonly verifyInputs: () => void | Promise<void>;
  /** Undoes whatever the run edited, before the inputs are verified again. */
  readonly restore?: () => Promise<void>;
  readonly signal?: AbortSignal;
  /** The check itself. Named so a caller can record what a different runner observed. */
  readonly check?: (request: RunRequest) => Promise<RunReport>;
}

export interface Recording {
  readonly resultPath: string;
  readonly failure?: RunFailure;
}

/**
 * Runs one subject against the pinned checkout and publishes the result only if every step of
 * the recording held.
 *
 * A recorded failure is evidence and is published like any other result — a subject that cannot
 * start is a finding, not a missing run. What may never be published is a result whose own
 * recording did not hold: an upstream command that failed or was abandoned, or a checkout that
 * is no longer the pinned one by the time the run ends. Those describe the recording rather than
 * the subject, and the difference is invisible in the result document itself.
 */
export async function record(request: RecordRequest): Promise<Recording> {
  const check = request.check ?? runCompatibilityCheck;

  // Before any command runs: afterwards there is no way to tell what the run actually observed.
  await request.verifyInputs();

  await rm(request.stagingRoot, { recursive: true, force: true });
  await mkdir(request.stagingRoot, { recursive: true });

  try {
    let report: RunReport;
    try {
      report = await check({
        manifest: request.manifest,
        entryId: request.entryId,
        lifecycle: request.lifecycle,
        subject: request.subject,
        environment: request.environment,
        projectRoot: request.checkoutRoot,
        artifactRoot: request.stagingRoot,
        ...(request.origin === undefined ? {} : { origin: request.origin }),
        declared: request.declared,
        ...(request.browser === undefined ? {} : { browser: request.browser }),
        ...(request.update === undefined ? {} : { update: request.update }),
        timeouts: request.timeouts,
      });
    } finally {
      await request.restore?.();
    }

    // After everything, not only after the one edit this adapter knows it made. The project's own
    // spec and build run arbitrary code in the checkout; undoing a known edit proves nothing about
    // what else they left behind, or about an input that is not in the checkout's history at all.
    await request.verifyInputs();

    await publish(request.stagingRoot, request.publishRoot);

    return report.failure === undefined
      ? { resultPath: join(request.publishRoot, "result.json") }
      : { resultPath: join(request.publishRoot, "result.json"), failure: report.failure };
  } finally {
    // A run that failed leaves no half-written evidence anywhere for a later one to inherit.
    await rm(request.stagingRoot, { recursive: true, force: true });
  }
}

/**
 * Replaces the published evidence in one step. Evidence paths inside the result are relative to
 * the result file, so the directory can move without invalidating them.
 */
async function publish(stagingRoot: string, publishRoot: string): Promise<void> {
  await mkdir(dirname(publishRoot), { recursive: true });
  await rm(publishRoot, { recursive: true, force: true });
  await rename(stagingRoot, publishRoot);
}

/**
 * Waits for the running document to show `text`.
 *
 * The budget is the caller's: this is inside the runner's update window, and an update that
 * never arrives has to end when the phase does rather than on a private clock of its own.
 */
export async function waitForText(
  page: BrowserPage,
  text: string,
  signal: AbortSignal,
  pollMs = 500,
): Promise<void> {
  const expression = `document.body.innerText.includes(${JSON.stringify(text)})`;
  for (;;) {
    if (signal.aborted) throw new Error(`the update never produced ${JSON.stringify(text)}`);
    if ((await page.evaluate(expression, signal)) === true) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
