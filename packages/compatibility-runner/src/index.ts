import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createContractValidators } from "@rsvite/compatibility-contract";
import {
  judgeUpdateWindow,
  normalizeEvents,
  type BrowserAdapter,
  type BrowserEvent,
  type BrowserPage,
} from "./browser.ts";
import { runCommand, startCommand, type CommandSpec, type CommandOutcome } from "./process.ts";
import { waitForReadiness, type ReadinessSpec } from "./readiness.ts";

export * from "./browser.ts";
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

/** How long a timed-out step is given to settle after it is asked to stop. */
const CLEANUP_GRACE_MS = 1_000;

type Bounded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/**
 * Runs work under a deadline the runner owns. Racing alone would only stop the waiting: the
 * adapter would keep driving a browser the run has already left behind. The work is therefore
 * given an `AbortSignal`, and on expiry it is asked to stop and given a bounded grace period to
 * settle before the runner moves on.
 */
async function underDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<Bounded<T>> {
  const controller = new AbortController();
  const work = start(controller.signal);
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, reason: `${what} failed: ${String(error)}` }),
  );

  const expired = Symbol("expired");
  const first = await Promise.race([settled, delay(timeoutMs, expired)]);
  if (first !== expired) return first as Bounded<T>;

  controller.abort(new Error(`${what} exceeded ${String(timeoutMs)}ms`));
  await Promise.race([settled, delay(CLEANUP_GRACE_MS, undefined)]);
  return { ok: false, reason: `${what} did not finish within ${String(timeoutMs)}ms` };
}

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
  let events: BrowserEvent[] = [];
  let failure: RunFailure | undefined;
  let lifecycleOutcome: CommandOutcome;

  try {
    // The budget starts at spawn and covers readiness and the browser phase together, so a
    // slow start cannot buy the browser more time than the caller allowed for the whole thing.
    const phase = await underDeadline(
      () =>
        lifecyclePhase(request, entry, started, (observed) => {
          events = observed;
        }),
      request.timeouts.lifecycleMs,
      `the ${request.lifecycle} phase`,
    );
    failure = phase.ok ? phase.value : { phase: request.lifecycle, message: phase.reason };
  } finally {
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

async function lifecyclePhase(
  request: RunRequest,
  entry: ManifestEntry,
  started: ReturnType<typeof startCommand>,
  collect: (events: BrowserEvent[]) => void,
): Promise<RunFailure | undefined> {
  const readiness = await waitForReadiness(entry.readiness, started, request.origin);
  if (!readiness.ready) {
    return { phase: request.lifecycle, message: readiness.reason ?? "readiness was not reached" };
  }
  if (request.browser === undefined) return undefined;

  const observed = await observeBrowser(request, entry);
  collect(observed.events);
  return observed.failure;
}

async function observeBrowser(
  request: RunRequest,
  entry: ManifestEntry,
): Promise<{ events: BrowserEvent[]; failure?: RunFailure }> {
  const acceptance = entry.browserAcceptance;
  const browser = request.browser;
  if (acceptance === undefined || browser === undefined || request.origin === undefined) {
    return { events: [] };
  }

  const budget = request.timeouts.browserMs;
  const url = new URL(acceptance.entryPath, request.origin).toString();
  const opened = await underDeadline(
    (signal) => browser.open({ url, timeoutMs: budget, signal }),
    budget,
    "opening the page",
  );
  if (!opened.ok) return { events: [], failure: { phase: "browser", message: opened.reason } };

  const page = opened.value;
  const events: BrowserEvent[] = [];
  try {
    const sentinelExpression = acceptance.hmr?.sentinelExpression;
    const before = await readSentinel(page, sentinelExpression, budget);
    if (!before.ok) return { events, failure: { phase: "browser", message: before.reason } };
    events.push(...page.drainEvents());

    if (request.update !== undefined) {
      const update = request.update;
      const updated = await underDeadline((signal) => update(page, signal), budget, "the update");
      if (!updated.ok) return { events, failure: { phase: "browser", message: updated.reason } };

      const windowEvents = page.drainEvents();
      events.push(...windowEvents);
      const after = await readSentinel(page, sentinelExpression, budget);
      if (!after.ok) return { events, failure: { phase: "browser", message: after.reason } };

      const verdict = judgeUpdateWindow({
        sentinelBefore: before.value,
        sentinelAfter: after.value,
        events: windowEvents,
      });
      if (verdict.fullReload) {
        return {
          events,
          failure: { phase: "browser", message: `the update was a full reload: ${verdict.reason}` },
        };
      }
    }

    const observation = normalizeEvents(events);
    const first = observation.errors[0];
    if (first !== undefined) {
      return { events, failure: { phase: "browser", message: `${first.type}: ${first.message}` } };
    }
    return { events };
  } finally {
    await closeQuietly(page);
  }
}

async function readSentinel(
  page: BrowserPage,
  expression: string | undefined,
  budget: number,
): Promise<Bounded<unknown>> {
  if (expression === undefined) return { ok: true, value: undefined };
  return underDeadline(
    (signal) => page.evaluate(expression, signal),
    budget,
    "reading the sentinel",
  );
}

/** Closing is best effort: a page that will not close must not mask the run's own outcome. */
async function closeQuietly(page: BrowserPage): Promise<void> {
  await underDeadline((signal) => page.close(signal), CLEANUP_GRACE_MS, "closing the page");
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

  // Written only after the contract accepted it, so an invalid document never reaches disk.
  const resultPath = join(request.artifactRoot, "result.json");
  await writeFile(resultPath, `${JSON.stringify(result, undefined, 2)}\n`, "utf8");

  return { result, resultPath, ...(failure ? { failure } : {}), logs };
}
