import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createContractValidators } from "@rsvite/compatibility-contract";
import {
  judgeUpdateWindow,
  normalizeEvents,
  type BrowserAdapter,
  type BrowserEvent,
  type BrowserPage,
} from "./browser.ts";
import { deadline, runUnder, type Bounded, type Deadline } from "./deadline.ts";
import { runCommand, startCommand, type CommandSpec, type CommandOutcome } from "./process.ts";
import { waitForReadiness, type ReadinessSpec } from "./readiness.ts";

export * from "./browser.ts";
export { AbandonedWorkError, type Bounded, type Deadline } from "./deadline.ts";
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
   * The adapter's update window: whatever it does here (edit a file, wait for text) happens
   * between the two sentinel reads. It reports; the runner judges.
   */
  readonly update?: (page: BrowserPage, signal: AbortSignal) => Promise<void>;
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

interface ManifestEntry {
  readonly id: string;
  readonly source: { readonly commit: string };
  readonly commands: Readonly<Record<string, CommandSpec | undefined>>;
  readonly readiness: ReadinessSpec;
  readonly browserAcceptance?: {
    readonly entryPath: string;
    readonly hmr?: { readonly sentinelExpression: string };
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

  const now = request.now ?? (() => new Date());
  const startedAt = now().toISOString();

  await mkdir(request.artifactRoot, { recursive: true });
  const logs = {
    install: logPaths(request.artifactRoot, "install"),
    lifecycle: logPaths(request.artifactRoot, request.lifecycle),
  };

  const installOutcome = await runCommand(
    inProject(install, request.projectRoot),
    request.timeouts.installMs,
    logs.install,
  );
  const installProblem = describeExit(installOutcome, "install");
  if (installProblem !== undefined) {
    return finish(validators, request, entry, startedAt, now, logs, installOutcome, [], {
      phase: "install",
      message: installProblem,
    });
  }

  const started = startCommand(inProject(lifecycle, request.projectRoot), logs.lifecycle);
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

  if (failure === undefined && entry.readiness.type === "process-exit") {
    const exitProblem = describeExit(lifecycleOutcome, request.lifecycle);
    if (exitProblem !== undefined) failure = { phase: request.lifecycle, message: exitProblem };
  }

  return finish(
    validators,
    request,
    entry,
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
  readonly failure?: RunFailure;
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
    return {
      events: [],
      failure: {
        phase: request.lifecycle,
        message: readiness.reason ?? "readiness was not reached",
      },
    };
  }

  const hmrProblem = missingHmrEvidence(request, entry);
  if (hmrProblem !== undefined) {
    return { events: [], failure: { phase: "browser", message: hmrProblem } };
  }
  if (request.browser === undefined) return { events: [] };

  const observed = await observeBrowser(request, entry, lifecycleBound);
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
 * inputs that make the claim checkable are required before the claim is allowed.
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
  if (request.update === undefined) {
    return `the run claims ${HMR_CAPABILITY} but no update was performed`;
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

  try {
    const opened = await runUnder(
      (signal) => browser.open({ url, timeoutMs: browserBound.remaining(), signal }),
      browserBound,
      "opening the page",
      CLEANUP_GRACE_MS,
    );
    if (!opened.ok) return { events: [], failure: { phase: "browser", message: opened.reason } };

    const page = opened.value;
    const events: BrowserEvent[] = [];
    try {
      const expression = acceptance.hmr?.sentinelExpression;
      const before = await readSentinel(page, expression, browserBound);
      if (!before.ok) return { events, failure: { phase: "browser", message: before.reason } };
      events.push(...page.drainEvents());

      if (claimsHmr && before.value === undefined) {
        return {
          events,
          failure: {
            phase: "browser",
            message: `the run claims ${HMR_CAPABILITY} but the page had no in-memory sentinel before the update`,
          },
        };
      }

      if (request.update !== undefined) {
        const update = request.update;
        const updated = await runUnder(
          (signal) => update(page, signal),
          browserBound,
          "the update",
          CLEANUP_GRACE_MS,
        );
        if (!updated.ok) return { events, failure: { phase: "browser", message: updated.reason } };

        const windowEvents = page.drainEvents();
        events.push(...windowEvents);
        const after = await readSentinel(page, expression, browserBound);
        if (!after.ok) return { events, failure: { phase: "browser", message: after.reason } };

        const verdict = judgeUpdateWindow({
          sentinelBefore: before.value,
          sentinelAfter: after.value,
          events: windowEvents,
        });
        if (verdict.fullReload) {
          return {
            events,
            failure: {
              phase: "browser",
              message: `the update was a full reload: ${verdict.reason ?? "no reason given"}`,
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
      await closeQuietly(page);
    }
  } finally {
    browserBound.dispose();
  }
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
 * Cleanup gets its own deadline. Handing `close` the already-aborted operation signal would let
 * an adapter reject immediately and skip the cleanup this call exists to perform.
 */
async function closeQuietly(page: BrowserPage): Promise<void> {
  const cleanup = deadline(CLEANUP_GRACE_MS);
  try {
    await runUnder((signal) => page.close(signal), cleanup, "closing the page", CLEANUP_GRACE_MS);
  } finally {
    cleanup.dispose();
  }
}

async function finish(
  validators: ReturnType<typeof createContractValidators>,
  request: RunRequest,
  entry: ManifestEntry,
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
      argv: [...(entry.commands[commandName]?.argv ?? [])],
      cwd: request.projectRoot,
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
    const evidence = basename(logs[failedPhase].stderr);
    result["firstIncompatibleBehavior"] = {
      phase: failure.phase,
      message: failure.message,
      ...(artifactPaths.includes(evidence) ? { evidencePath: evidence } : {}),
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
