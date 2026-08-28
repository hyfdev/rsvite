import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createContractValidators } from "@rsvite/compatibility-contract";
import {
  normalizeEvents,
  type BrowserAdapter,
  type BrowserEvent,
  type BrowserPage,
} from "./browser.ts";
import { deadline, runUnder, type Bounded, type Deadline } from "./deadline.ts";
import {
  createHmrUpdate,
  pageHasExpectedText,
  runDefaultHmrUpdate,
  type HmrAcceptance,
  type HmrUpdate,
  type PreparedHmrUpdate,
} from "./hmr.ts";
import { runCommand, startCommand, type CommandSpec, type CommandOutcome } from "./process.ts";
import { waitForReadiness, type ReadinessSpec } from "./readiness.ts";

export * from "./browser.ts";
export { AbandonedWorkError, type Bounded, type Deadline } from "./deadline.ts";
export { type HmrUpdate } from "./hmr.ts";
export * from "./process.ts";
export * from "./readiness.ts";
export {
  createSyntheticBrowser,
  type SyntheticPage,
  type SyntheticScript,
} from "./synthetic-browser.ts";

export type LifecycleName = "dev" | "build" | "preview" | "test";

export interface RunEnvironment {
  readonly os: string;
  readonly arch: string;
  readonly runnerImage: string;
  readonly nodeVersion: string;
  readonly packageManager: { readonly name: string; readonly version: string };
  readonly browser?: { readonly name: string; readonly version: string };
}

export interface RunFailure {
  readonly phase: "install" | LifecycleName | "browser";
  readonly message: string;
}

interface ObservedFailure extends RunFailure {
  /**
   * The failure exists only because a budget expired. Such a failure is always later than
   * whatever caused the budget to end, so it must not outrank an earlier cause — while a
   * failure the page actually reported must not be overwritten by a later one.
   */
  readonly fromDeadline?: boolean;
}

/**
 * What the runner records but must not decide. Which capabilities a run set out to verify, which
 * implementation owns them, what fell back, and what a failure means are product judgments; the
 * runner would have to guess them from command output, and a guess in the evidence is worse than
 * a missing run.
 */
export interface DeclaredRunInputs {
  readonly javascriptApiLevel: "C0" | "C1" | "C2" | "C3";
  readonly capabilityOwners: readonly { readonly capability: string; readonly owner: string }[];
  readonly explicitFallbacks: readonly {
    readonly component: string;
    readonly capabilities: readonly string[];
    readonly reason: string;
  }[];
  readonly classifyFailure: (
    failure: RunFailure,
  ) => { readonly kind: string; readonly evidence: string } | undefined;
}

export interface RunRequest {
  readonly manifest: unknown;
  readonly entryId: string;
  readonly lifecycle: LifecycleName;
  readonly subject: {
    readonly name: "vite" | "rsvite";
    readonly version: string;
    readonly commit?: string;
  };
  readonly environment: RunEnvironment;
  /** The pinned checkout this run operates on. */
  readonly projectRoot: string;
  /** A directory this run owns; logs are written under it and referenced from the result. */
  readonly artifactRoot: string;
  /** Where the served application is reachable, for http readiness and for the browser. */
  readonly origin?: string;
  readonly declared: DeclaredRunInputs;
  readonly browser?: BrowserAdapter;
  /**
   * Overrides the runner's default manifest-declared HMR edit and expected-text wait. A run that
   * claims HMR must call `hmr.apply()` from its override; the runner restores the edit after the
   * update window on every exit path. The override reports project-specific facts; the runner
   * judges navigation, errors, and sentinel survival.
   */
  readonly update?: (page: BrowserPage, signal: AbortSignal, hmr: HmrUpdate) => Promise<void>;
  readonly timeouts: {
    readonly installMs: number;
    readonly lifecycleMs: number;
    readonly browserMs: number;
  };
  readonly now?: () => Date;
}

export interface RunReport {
  /** The raw result document, already accepted with its manifest by the contract validator. */
  readonly result: unknown;
  /** Where the result was written. Evidence paths in it are relative to this file. */
  readonly resultPath: string;
  readonly failure?: RunFailure;
  readonly logs: { readonly install: LogPaths; readonly lifecycle: LogPaths };
}

interface LogPaths {
  readonly stdout: string;
  readonly stderr: string;
}

/** How long an aborted step is given to settle, and how long page cleanup gets of its own. */
const CLEANUP_GRACE_MS = 1_000;

const HMR_CAPABILITY = "hmr-without-full-reload";

const LIFECYCLE_NAMES: readonly LifecycleName[] = ["dev", "build", "preview", "test"];

interface ManifestEntry {
  readonly id: string;
  readonly source: { readonly commit: string };
  readonly commands: Readonly<Record<string, CommandSpec | undefined>>;
  readonly readiness: ReadinessSpec;
  readonly browserAcceptance?: {
    readonly entryPath: string;
    readonly hmr?: HmrAcceptance;
  };
}

function selectEntry(manifest: unknown, entryId: string): ManifestEntry {
  const entries = (manifest as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) throw new Error("the manifest has no entries");
  const entry = entries.find((candidate) => (candidate as { id?: unknown })?.id === entryId);
  if (entry === undefined) throw new Error(`the manifest has no entry ${entryId}`);
  return entry as ManifestEntry;
}

function inProject(command: CommandSpec, projectRoot: string): CommandSpec {
  return {
    ...command,
    cwd: command.cwd === undefined ? projectRoot : join(projectRoot, command.cwd),
  };
}

function describeExit(outcome: CommandOutcome, label: string): string | undefined {
  // A command that never started did not exit with an unknown code; it failed to start, and
  // the reason is the only useful thing the record can carry.
  if (outcome.startError !== undefined) return `${label} could not start: ${outcome.startError}`;
  if (outcome.timedOut) return `${label} did not finish within its timeout`;
  if (outcome.exitCode !== 0) {
    return `${label} exited with code ${String(outcome.exitCode)}${
      outcome.signal ? ` after ${outcome.signal}` : ""
    }`;
  }
  return undefined;
}

function logPaths(artifactRoot: string, label: string): LogPaths {
  return {
    stdout: join(artifactRoot, `${label}.stdout.log`),
    stderr: join(artifactRoot, `${label}.stderr.log`),
  };
}

/**
 * Runs one install plus one selected lifecycle command for one entry under one subject, then
 * writes the raw result beside its logs. Vite and rsvite reach this through the same path: the
 * subject only changes which commands the manifest entry names and what the caller declares.
 */
export async function runCompatibilityCheck(request: RunRequest): Promise<RunReport> {
  const validators = createContractValidators();
  // Before anything on disk or in a process. A malformed manifest describes commands nobody
  // agreed to run, so it is refused while refusing it is still free.
  const manifestCheck = validators.validateCorpusManifest(request.manifest);
  if (!manifestCheck.valid) {
    throw new Error(
      `the manifest is not valid, so no command was run:\n${manifestCheck.violations
        .map((violation) => violation.message)
        .join("\n")}`,
    );
  }

  const entry = selectEntry(request.manifest, request.entryId);
  const install = entry.commands["install"];
  if (install === undefined) throw new Error(`entry ${entry.id} declares no install command`);
  const lifecycle = entry.commands[request.lifecycle];
  if (lifecycle === undefined) {
    throw new Error(`entry ${entry.id} declares no ${request.lifecycle} command`);
  }
  const resolved = {
    install: inProject(install, request.projectRoot),
    lifecycle: inProject(lifecycle, request.projectRoot),
  };

  const now = request.now ?? (() => new Date());
  const startedAt = now().toISOString();

  await mkdir(request.artifactRoot, { recursive: true });
  // A reused directory must not donate evidence to this run: existence alone cannot tell a log
  // this run wrote from one left by an earlier one, so the runner clears what it owns first.
  await Promise.all(
    ["install", ...LIFECYCLE_NAMES].flatMap((label) => {
      const pair = logPaths(request.artifactRoot, label);
      return [rm(pair.stdout, { force: true }), rm(pair.stderr, { force: true })];
    }),
  );
  await rm(join(request.artifactRoot, "result.json"), { force: true });
  const logs = {
    install: logPaths(request.artifactRoot, "install"),
    lifecycle: logPaths(request.artifactRoot, request.lifecycle),
  };

  const installOutcome = await runCommand(
    resolved.install,
    request.timeouts.installMs,
    logs.install,
  );
  const installProblem = describeExit(installOutcome, "install");
  if (installProblem !== undefined) {
    return finish(validators, request, entry, resolved, startedAt, now, logs, installOutcome, [], {
      phase: "install",
      message: installProblem,
    });
  }

  const started = startCommand(resolved.lifecycle, logs.lifecycle);
  // One budget, starting at spawn, owning every step underneath it. Readiness and the browser
  // derive from it rather than waiting independently, so a slow start cannot buy the browser
  // more time than the caller allowed for the whole phase.
  const lifecycleBound = deadline(request.timeouts.lifecycleMs);
  let events: BrowserEvent[] = [];
  let failure: RunFailure | undefined;
  let lifecycleOutcome: CommandOutcome;

  try {
    const observed = await lifecyclePhase(request, entry, started, lifecycleBound);
    events = observed.events;
    failure = observed.failure;
  } finally {
    lifecycleBound.dispose();
    lifecycleOutcome = await started.stop();
  }

  if (failure === undefined) {
    // Only `process-exit` readiness defines the command ending as normal completion, and even
    // then a nonzero code fails. Under HTTP or stdout readiness the command is supposed to keep
    // serving through acceptance, so ending at all is a failure — a dev server that reports
    // ready and then exits cleanly is not a server anything was measured against. Whether it
    // ended by itself is decided by `stop`, which asks the operating system rather than waiting
    // for an event that can arrive later than the answer.
    const exitProblem =
      entry.readiness.type === "process-exit"
        ? describeExit(lifecycleOutcome, request.lifecycle)
        : started.exitedOnItsOwn()
          ? (describeExit(lifecycleOutcome, request.lifecycle) ??
            `${request.lifecycle} ended on its own after reporting readiness`)
          : undefined;
    if (exitProblem !== undefined) failure = { phase: request.lifecycle, message: exitProblem };
  }

  return finish(
    validators,
    request,
    entry,
    resolved,
    startedAt,
    now,
    logs,
    lifecycleOutcome,
    events,
    failure,
  );
}

interface Observed {
  readonly events: BrowserEvent[];
  readonly failure?: ObservedFailure;
}

async function lifecyclePhase(
  request: RunRequest,
  entry: ManifestEntry,
  started: ReturnType<typeof startCommand>,
  lifecycleBound: Deadline,
): Promise<Observed> {
  const readiness = await waitForReadiness(
    entry.readiness,
    started,
    request.origin,
    lifecycleBound.signal,
  );
  if (lifecycleBound.expired()) {
    return {
      events: [],
      failure: {
        phase: request.lifecycle,
        message: `the ${request.lifecycle} phase did not finish within ${String(request.timeouts.lifecycleMs)}ms`,
      },
    };
  }
  if (!readiness.ready) {
    // A command that never started did not fail to become ready; it failed to exist. Saying
    // "readiness was not reached" would send a reader looking for a server that was never run.
    const startError = started.startErrorSoFar();
    return {
      events: [],
      failure: {
        phase: request.lifecycle,
        message:
          startError === undefined
            ? (readiness.reason ?? "readiness was not reached")
            : `${request.lifecycle} could not start: ${startError}`,
      },
    };
  }

  const hmrProblem = missingHmrEvidence(request, entry);
  if (hmrProblem !== undefined) {
    return { events: [], failure: { phase: "browser", message: hmrProblem } };
  }
  if (request.browser === undefined) return { events: [] };

  // The command's own death competes with acceptance instead of being sampled after it. A
  // server that vanishes 100ms in must not lose first place to a browser deadline at 500ms.
  const acceptance = deadline(lifecycleBound.remaining(), lifecycleBound.signal);
  let vanished = false;
  void started.exited.then(() => {
    vanished = true;
    acceptance.abort(new Error("the lifecycle command ended during acceptance"));
  });

  let observed: Observed;
  try {
    observed = await observeBrowser(request, entry, acceptance);
  } finally {
    acceptance.dispose();
  }

  // The command's death outranks a browser failure that only exists because that death
  // aborted the browser budget, and yields to one the page actually reported first.
  if (vanished && entry.readiness.type !== "process-exit") {
    if (observed.failure === undefined || observed.failure.fromDeadline === true) {
      return {
        events: observed.events,
        failure: {
          phase: request.lifecycle,
          message: `${request.lifecycle} ended on its own during browser acceptance`,
        },
      };
    }
  }
  if (observed.failure === undefined && lifecycleBound.expired()) {
    return {
      events: observed.events,
      failure: {
        phase: request.lifecycle,
        message: `the ${request.lifecycle} phase did not finish within ${String(request.timeouts.lifecycleMs)}ms`,
      },
    };
  }
  return observed;
}

/**
 * A run that claims HMR has to have looked. Skipping the browser, or reading a sentinel the page
 * never set, produces the same "no navigation, nothing changed" shape as a genuine pass, so the
 * inputs that make the claim checkable are required before the claim is allowed. The update
 * itself comes from the manifest unless an adapter overrides it.
 */
function missingHmrEvidence(request: RunRequest, entry: ManifestEntry): string | undefined {
  const claimsHmr = request.declared.capabilityOwners.some(
    (owner) => owner.capability === HMR_CAPABILITY,
  );
  if (!claimsHmr) return undefined;

  if (request.browser === undefined)
    return `the run claims ${HMR_CAPABILITY} but no browser was given`;
  if (request.origin === undefined)
    return `the run claims ${HMR_CAPABILITY} but no origin was given`;
  if (entry.browserAcceptance?.hmr === undefined) {
    return `the run claims ${HMR_CAPABILITY} but the manifest entry declares no HMR acceptance`;
  }
  return undefined;
}

async function observeBrowser(
  request: RunRequest,
  entry: ManifestEntry,
  lifecycleBound: Deadline,
): Promise<Observed> {
  const acceptance = entry.browserAcceptance;
  const browser = request.browser;
  if (acceptance === undefined || browser === undefined || request.origin === undefined) {
    return { events: [] };
  }

  const claimsHmr = request.declared.capabilityOwners.some(
    (owner) => owner.capability === HMR_CAPABILITY,
  );
  // One budget for the whole browser phase, never larger than what the lifecycle has left.
  // Granting it per step is how four 180ms steps used to fit inside a 250ms allowance.
  const browserBound = deadline(
    Math.min(request.timeouts.browserMs, lifecycleBound.remaining()),
    lifecycleBound.signal,
  );
  const url = new URL(acceptance.entryPath, request.origin).toString();
  let hmrUpdate: PreparedHmrUpdate | undefined;

  try {
    const opened = await runUnder(
      (signal) => browser.open({ url, timeoutMs: browserBound.remaining(), signal }),
      browserBound,
      "opening the page",
      CLEANUP_GRACE_MS,
    );
    if (!opened.ok) {
      // The adapter may have obeyed the contract and produced the page just after the abort.
      if (opened.late !== undefined) await closeOrFail(opened.late);
      return { events: [], failure: earlierOf([], opened) };
    }

    const page = opened.value;
    const events: BrowserEvent[] = [];
    try {
      const expression = acceptance.hmr?.sentinelExpression;
      const before = await readSentinel(page, expression, browserBound);
      events.push(...page.drainEvents());
      if (!before.ok) return { events, failure: earlierOf(events, before) };

      // Checked here, before the update, so an error the page reported on load is the first
      // incompatible behavior rather than whatever the update happens to produce later.
      const onLoad = firstBrowserError(events);
      if (onLoad !== undefined) return { events, failure: onLoad };

      if (claimsHmr && before.value === undefined) {
        return {
          events,
          failure: {
            phase: "browser",
            message: `the run claims ${HMR_CAPABILITY} but the page had no in-memory sentinel before the update`,
          },
        };
      }

      if (claimsHmr || request.update !== undefined) {
        if (acceptance.hmr === undefined) {
          return {
            events,
            failure: {
              phase: "browser",
              message:
                "an HMR update was requested but the manifest entry declares no HMR acceptance",
            },
          };
        }
        const preparedUpdate = createHmrUpdate(request.projectRoot, acceptance.hmr);
        hmrUpdate = preparedUpdate;
        const adapterUpdate = request.update;
        let updateWindowOpen = true;
        const updated = await (async () => {
          try {
            return await runUnder(
              async (signal) => {
                const assertUpdateWindowOpen = () => {
                  if (!updateWindowOpen || signal.aborted) {
                    throw new Error(
                      "the manifest-declared HMR edit cannot be applied after the update window closes",
                    );
                  }
                };
                const apply = () => preparedUpdate.applyWhile(assertUpdateWindowOpen);

                if (adapterUpdate === undefined) {
                  await runDefaultHmrUpdate(page, signal, {
                    expectedText: preparedUpdate.expectedText,
                    apply,
                    restore: () => preparedUpdate.restore(),
                  });
                  return;
                }
                let expectedTextObserved: boolean | undefined;
                let expectedTextFailure: { readonly error: unknown } | undefined;
                const missingExpectedText = () =>
                  new Error(
                    "the adapter update did not produce the manifest-declared expectedText",
                  );
                const adapterHmrUpdate: HmrUpdate = {
                  expectedText: preparedUpdate.expectedText,
                  apply,
                  async restore(): Promise<void> {
                    if (!preparedUpdate.isApplied()) return;
                    try {
                      const observed = await pageHasExpectedText(
                        page,
                        signal,
                        preparedUpdate.expectedText,
                      );
                      expectedTextObserved = (expectedTextObserved ?? true) && observed;
                    } catch (error) {
                      expectedTextFailure ??= { error };
                    } finally {
                      await preparedUpdate.restore();
                    }
                  },
                };
                await adapterUpdate(page, signal, adapterHmrUpdate);
                if (claimsHmr && !preparedUpdate.wasApplied()) {
                  throw new Error(
                    "the adapter update did not apply the manifest-declared HMR edit",
                  );
                }
                if (claimsHmr) {
                  if (expectedTextFailure !== undefined) throw expectedTextFailure.error;
                  if (
                    expectedTextObserved === false ||
                    (expectedTextObserved === undefined &&
                      !(await pageHasExpectedText(page, signal, preparedUpdate.expectedText)))
                  ) {
                    throw missingExpectedText();
                  }
                }
              },
              browserBound,
              "the update",
              CLEANUP_GRACE_MS,
            );
          } finally {
            updateWindowOpen = false;
          }
        })();
        // Drained after every awaited page operation, whether it succeeded or not: an update
        // that reports an error and then rejects has still reported that error, and it happened
        // first.
        const windowEvents = page.drainEvents();
        if (!updated.ok) {
          events.push(...windowEvents);
          return { events, failure: earlierOf(windowEvents, updated) };
        }

        const after = await readSentinel(page, expression, browserBound);
        windowEvents.push(...page.drainEvents());
        events.push(...windowEvents);
        if (!after.ok) return { events, failure: earlierOf(windowEvents, after) };

        // One ordered stream decides which incompatibility came first. A navigation wins only
        // when it was observed before an error, and a lost sentinel is observed last of all,
        // because it is only knowable once the final read has happened.
        const decisive = decisiveFailure(windowEvents);
        if (decisive !== undefined) return { events, failure: decisive };
        if (!Object.is(before.value, after.value)) {
          return {
            events,
            failure: {
              phase: "browser",
              message:
                "the update was a full reload: the in-memory sentinel did not survive the update, so the document was replaced",
            },
          };
        }
      }

      const observation = normalizeEvents(events);
      const first = observation.errors[0];
      if (first !== undefined) {
        return {
          events,
          failure: { phase: "browser", message: `${first.type}: ${first.message}` },
        };
      }
      return { events };
    } finally {
      await closeOrFail(page);
    }
  } finally {
    browserBound.dispose();
    await hmrUpdate?.restore();
  }
}

/**
 * An operation that rejected did so after whatever the page had already reported, so a recorded
 * event — an error or a navigation — outranks its reason. A timeout is different: the clock
 * ended it at a fixed moment, and anything drained afterwards came from work that was still
 * running, so the timeout keeps its place.
 */
function earlierOf(
  events: readonly BrowserEvent[],
  failure: { readonly reason: string; readonly timedOut?: boolean },
): ObservedFailure {
  const asDeadline: ObservedFailure = {
    phase: "browser",
    message: failure.reason,
    ...(failure.timedOut === true ? { fromDeadline: true } : {}),
  };
  if (failure.timedOut === true) return asDeadline;
  return decisiveFailure(events) ?? asDeadline;
}

/** The first thing the page reported that ends a run, in the order it was observed. */
function decisiveFailure(events: readonly BrowserEvent[]): ObservedFailure | undefined {
  const decisive = events.find(
    (event) => event.type === "main-frame-navigated" || isErrorEvent(event),
  );
  if (decisive === undefined) return undefined;
  if (decisive.type === "main-frame-navigated") {
    return {
      phase: "browser",
      message: `the update was a full reload: the main frame navigated to ${decisive.url} during the update window`,
    };
  }
  return firstBrowserError([decisive]);
}

function isErrorEvent(event: BrowserEvent): boolean {
  return event.type !== "main-frame-navigated";
}

function firstBrowserError(events: readonly BrowserEvent[]): RunFailure | undefined {
  const first = normalizeEvents(events).errors[0];
  if (first === undefined) return undefined;
  return { phase: "browser", message: `${first.type}: ${first.message}` };
}

async function readSentinel(
  page: BrowserPage,
  expression: string | undefined,
  bound: Deadline,
): Promise<Bounded<unknown>> {
  if (expression === undefined) return { ok: true, value: undefined };
  return runUnder(
    (signal) => page.evaluate(expression, signal),
    bound,
    "reading the sentinel",
    CLEANUP_GRACE_MS,
  );
}

/**
 * Cleanup gets its own deadline: handing `close` the already-aborted operation signal would let
 * an adapter reject immediately and skip the cleanup this call exists to perform. A close that
 * fails raises, because a result written over a browser that is still open describes a run whose
 * resources nobody accounted for.
 */
async function closeOrFail(page: BrowserPage): Promise<void> {
  const cleanup = deadline(CLEANUP_GRACE_MS);
  try {
    const closed = await runUnder(
      (signal) => page.close(signal),
      cleanup,
      "closing the page",
      CLEANUP_GRACE_MS,
    );
    if (!closed.ok) throw new Error(closed.reason);
  } finally {
    cleanup.dispose();
  }
}

async function finish(
  validators: ReturnType<typeof createContractValidators>,
  request: RunRequest,
  entry: ManifestEntry,
  resolved: { install: CommandSpec; lifecycle: CommandSpec },
  startedAt: string,
  now: () => Date,
  logs: { install: LogPaths; lifecycle: LogPaths },
  outcome: CommandOutcome,
  events: readonly BrowserEvent[],
  failure: RunFailure | undefined,
): Promise<RunReport> {
  const observation = normalizeEvents(events);
  const failedPhase: "install" | "lifecycle" =
    failure?.phase === "install" ? "install" : "lifecycle";
  // The contract reads these as relative to the result file, and the runner writes the result
  // into the same directory as the logs, so the base is a fact rather than a convention. Only
  // files that exist are listed: naming evidence that is absent reads as evidence until opened.
  const artifactPaths = [logs.install, logs.lifecycle]
    .flatMap((pair) => [pair.stdout, pair.stderr])
    .filter((path) => existsSync(path))
    .map((path) => basename(path));

  const commandName = failedPhase === "install" ? "install" : request.lifecycle;
  const result: Record<string, unknown> = {
    contractVersion: 1,
    manifestEntry: { id: entry.id, sourceCommit: entry.source.commit },
    subject: {
      name: request.subject.name,
      version: request.subject.version,
      ...(request.subject.commit ? { commit: request.subject.commit } : {}),
    },
    environment: request.environment,
    command: {
      // The command as it actually ran, including a manifest `cwd` resolved under the project
      // root. Recording the project root instead would describe a run that did not happen.
      argv: [...(entry.commands[commandName]?.argv ?? [])],
      cwd:
        (failedPhase === "install" ? resolved.install : resolved.lifecycle).cwd ??
        request.projectRoot,
      exitCode: outcome.exitCode,
    },
    startedAt,
    finishedAt: now().toISOString(),
    outcome: failure === undefined ? "pass" : "fail",
    javascriptApiLevel: request.declared.javascriptApiLevel,
    capabilityOwners: request.declared.capabilityOwners.map((owner) => ({ ...owner })),
    explicitFallbacks: request.declared.explicitFallbacks.map((fallback) => ({
      component: fallback.component,
      capabilities: [...fallback.capabilities],
      reason: fallback.reason,
    })),
    browserErrors: observation.errors.map((error) => ({ ...error })),
    artifactPaths,
  };

  if (failure !== undefined) {
    // An install failure's evidence is the install log. Pointing at the lifecycle log would
    // send a reader to a file this run never created.
    const evidence = failure.phase === "browser" ? undefined : basename(logs[failedPhase].stderr);
    result["firstIncompatibleBehavior"] = {
      phase: failure.phase,
      message: failure.message,
      ...(evidence !== undefined && artifactPaths.includes(evidence)
        ? { evidencePath: evidence }
        : {}),
    };
    const classification = request.declared.classifyFailure(failure);
    if (classification === undefined) {
      throw new Error(
        `the run failed during ${failure.phase} and the caller classified nothing; the runner does not classify failures itself`,
      );
    }
    result["failureClassification"] = { ...classification };
  }

  const validation = validators.validateResultAgainstManifest(request.manifest, result);
  if (!validation.valid) {
    throw new Error(
      `the runner produced a result the contract rejects:\n${validation.violations
        .map((violation) => violation.message)
        .join("\n")}`,
    );
  }

  // Written only after the contract accepted it, and only once every abandoned operation has
  // settled: a result recorded while an adapter still runs would describe a run nobody stopped.
  const resultPath = join(request.artifactRoot, "result.json");
  await writeFile(resultPath, `${JSON.stringify(result, undefined, 2)}\n`, "utf8");

  return { result, resultPath, ...(failure ? { failure } : {}), logs };
}
