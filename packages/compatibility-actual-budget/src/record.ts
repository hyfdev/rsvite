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
import { assertPinnedCheckout, type Pin } from "./index.ts";
import { runUpstreamOrThrow, type UpstreamStep } from "./upstream.ts";

/**
 * The manifest one subject is measured under: the same entry, describing the same pinned input,
 * with the commands that subject is driven by. The entry records the project's own commands, so
 * running a different implementation means naming that implementation's commands here rather
 * than editing the corpus into something the project does not actually declare.
 */
export function manifestForSubject(
  manifest: unknown,
  entryId: string,
  commands: Readonly<Record<string, CommandSpec>>,
): unknown {
  const source = manifest as { entries: { id: string }[] };
  return {
    ...source,
    entries: source.entries.map((entry) =>
      entry.id === entryId ? { ...entry, commands: { ...commands } } : entry,
    ),
  };
}

export interface RecordRequest {
  readonly checkoutRoot: string;
  /** Already subject-specific: see `manifestForSubject`. */
  readonly manifest: unknown;
  readonly pin: Pin;
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
   * Upstream commands that must have succeeded before any result may be published. They run
   * first: a build that is attempted after the result is written cannot fail it, so a broken
   * build would leave evidence that reads as a pass.
   */
  readonly preconditions?: readonly UpstreamStep[];
  /** Undoes whatever the run edited, before the checkout is verified again. */
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

  // The checkout is only evidence while it is the pinned one, and that has to hold before any
  // command runs — afterwards there is no way to tell what the run observed.
  assertPinnedCheckout(request.checkoutRoot, request.pin);

  await rm(request.stagingRoot, { recursive: true, force: true });
  await mkdir(request.stagingRoot, { recursive: true });

  try {
    let report: RunReport;
    try {
      for (const step of request.preconditions ?? []) {
        await runUpstreamOrThrow(step, request.signal);
      }

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
    // what else they left behind.
    assertPinnedCheckout(request.checkoutRoot, request.pin);

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
