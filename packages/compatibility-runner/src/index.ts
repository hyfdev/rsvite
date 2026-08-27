import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
  classifyFailure(
    failure: RunFailure,
  ): { readonly kind: string; readonly evidence: string } | undefined;
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
  update?(page: BrowserPage): Promise<void>;
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
  readonly failure?: RunFailure;
  readonly logs: { readonly install: LogPaths; readonly lifecycle: LogPaths };
}

interface LogPaths {
  readonly stdout: string;
  readonly stderr: string;
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

/**
 * Runs one install plus one selected lifecycle command for one entry under one subject, then
 * emits the raw result. Vite and rsvite reach this through the same path: the subject only
 * changes which commands the manifest entry names and what the caller declares about ownership.
 */
export async function runCompatibilityCheck(request: RunRequest): Promise<RunReport> {
  const entry = selectEntry(request.manifest, request.entryId);
  const now = request.now ?? (() => new Date());
  const startedAt = now().toISOString();

  await mkdir(request.artifactRoot, { recursive: true });
  const logs = {
    install: logPaths(request.artifactRoot, "install"),
    lifecycle: logPaths(request.artifactRoot, request.lifecycle),
  };

  const install = entry.commands["install"];
  if (install === undefined) throw new Error(`entry ${entry.id} declares no install command`);
  const lifecycle = entry.commands[request.lifecycle];
  if (lifecycle === undefined) {
    throw new Error(`entry ${entry.id} declares no ${request.lifecycle} command`);
  }

  const installOutcome = await runCommand(
    inProject(install, request.projectRoot),
    request.timeouts.installMs,
    logs.install,
  );
  const installProblem = describeExit(installOutcome, "install");
  if (installProblem !== undefined) {
    return finish(request, entry, startedAt, now, logs, installOutcome, [], {
      phase: "install",
      message: installProblem,
    });
  }

  const started = startCommand(inProject(lifecycle, request.projectRoot), logs.lifecycle);
  let events: BrowserEvent[] = [];
  let failure: RunFailure | undefined;
  let lifecycleOutcome: CommandOutcome;

  try {
    const readiness = await waitForReadiness(entry.readiness, started, request.origin);
    if (!readiness.ready) {
      failure = {
        phase: request.lifecycle,
        message: readiness.reason ?? "readiness was not reached",
      };
    } else if (request.browser !== undefined) {
      const observed = await observeBrowser(request, entry);
      events = observed.events;
      failure = observed.failure;
    }
  } finally {
    lifecycleOutcome = await started.stop();
  }

  if (failure === undefined) {
    const exitProblem =
      entry.readiness.type === "process-exit"
        ? describeExit(lifecycleOutcome, request.lifecycle)
        : undefined;
    if (exitProblem !== undefined) failure = { phase: request.lifecycle, message: exitProblem };
  }

  return finish(request, entry, startedAt, now, logs, lifecycleOutcome, events, failure);
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

  let page: BrowserPage;
  try {
    page = await browser.open({
      url: new URL(acceptance.entryPath, request.origin).toString(),
      timeoutMs: request.timeouts.browserMs,
    });
  } catch (error) {
    return {
      events: [],
      failure: {
        phase: "browser",
        message: `the browser could not open the page: ${String(error)}`,
      },
    };
  }

  const events: BrowserEvent[] = [];
  try {
    const sentinelExpression = acceptance.hmr?.sentinelExpression;
    const sentinelBefore =
      sentinelExpression === undefined ? undefined : await page.evaluate(sentinelExpression);
    events.push(...page.drainEvents());

    if (request.update !== undefined) {
      await request.update(page);
      const windowEvents = page.drainEvents();
      events.push(...windowEvents);
      const sentinelAfter =
        sentinelExpression === undefined ? undefined : await page.evaluate(sentinelExpression);

      const verdict = judgeUpdateWindow({ sentinelBefore, sentinelAfter, events: windowEvents });
      if (verdict.fullReload) {
        return {
          events,
          failure: { phase: "browser", message: `the update was a full reload: ${verdict.reason}` },
        };
      }
    }

    const observation = normalizeEvents(events);
    if (observation.errors.length > 0) {
      const first = observation.errors[0]!;
      return { events, failure: { phase: "browser", message: `${first.type}: ${first.message}` } };
    }
    return { events };
  } catch (error) {
    return {
      events,
      failure: { phase: "browser", message: `the browser check failed: ${String(error)}` },
    };
  } finally {
    await page.close();
  }
}

function logPaths(artifactRoot: string, label: string): LogPaths {
  return {
    stdout: join(artifactRoot, `${label}.stdout.log`),
    stderr: join(artifactRoot, `${label}.stderr.log`),
  };
}

function finish(
  request: RunRequest,
  entry: ManifestEntry,
  startedAt: string,
  now: () => Date,
  logs: { install: LogPaths; lifecycle: LogPaths },
  outcome: CommandOutcome,
  events: readonly BrowserEvent[],
  failure: RunFailure | undefined,
): RunReport {
  const observation = normalizeEvents(events);
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
      argv: [
        ...(entry.commands[failure?.phase === "install" ? "install" : request.lifecycle]?.argv ??
          []),
      ],
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
    artifactPaths: [
      logs.install.stdout,
      logs.install.stderr,
      logs.lifecycle.stdout,
      logs.lifecycle.stderr,
    ],
  };

  if (failure !== undefined) {
    result["firstIncompatibleBehavior"] = {
      phase: failure.phase,
      message: failure.message,
      evidencePath: logs.lifecycle.stderr,
    };
    const classification = request.declared.classifyFailure(failure);
    if (classification === undefined) {
      throw new Error(
        `the run failed during ${failure.phase} and the caller classified nothing; the runner does not classify failures itself`,
      );
    }
    result["failureClassification"] = { ...classification };
  }

  const validation = createContractValidators().validateResultAgainstManifest(
    request.manifest,
    result,
  );
  if (!validation.valid) {
    throw new Error(
      `the runner produced a result the contract rejects:\n${validation.violations.map((v) => v.message).join("\n")}`,
    );
  }

  return { result, ...(failure ? { failure } : {}), logs };
}
