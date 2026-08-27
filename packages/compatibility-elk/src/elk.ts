import { createServer } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createContractValidators } from "@rsvite/compatibility-contract";
import {
  runCommand,
  runCompatibilityCheck,
  type BrowserAdapter,
  type BrowserPage,
  type RunEnvironment,
  type RunReport,
} from "@rsvite/compatibility-runner";
import {
  chromiumVersion,
  createChromiumBrowserAdapter,
  discardMainFrameNavigations,
} from "./chromium.ts";
import {
  createElkManifest,
  declaredElkRun,
  ELK_COMMIT,
  ELK_ENTRY_ID,
  ELK_HMR_FIND,
  ELK_HMR_REPLACE,
  ELK_HMR_STYLESHEET,
  ELK_HOME_PATH,
  ELK_PNPM_VERSION,
  ELK_REPOSITORY,
  ELK_SENTINEL,
  type ElkSubject,
} from "./manifest.ts";
import {
  summarizeColdPhase,
  waitForObservedStability,
  type ColdPhase,
  type StabilityOptions,
} from "./stability.ts";

const INSTALL_TIMEOUT_MS = 600_000;
const LIFECYCLE_TIMEOUT_MS = 900_000;
const BROWSER_TIMEOUT_MS = 600_000;
const PAGE_SETTLE_MS = 1_000;
const PAGE_PROBE_TIMEOUT_MS = 180_000;
const IGNORED_PAGE_ERROR = "NotSupportedError: Model not available";
const BUILD_OUTPUTS = [
  ".output/public/elk-sw.js",
  ".output/public/index.html",
  ".output/server/index.mjs",
] as const;

export interface ElkCheckout {
  readonly path: string;
  dispose(): Promise<void>;
}

export interface ElkViteBaseline {
  readonly dev: RunReport;
  readonly build: RunReport;
  readonly preview: RunReport;
}

export interface ElkEvidence extends ElkViteBaseline {
  readonly rsvite: RunReport;
}

export interface ElkRunOptions {
  readonly artifactRoot: string;
  readonly checkoutParent?: string;
  readonly existingCheckout?: string;
  readonly environment: RunEnvironment;
  readonly rsviteCommand?: readonly string[];
}

function commandFailed(
  label: string,
  outcome: Awaited<ReturnType<typeof runCommand>>,
): Error | undefined {
  if (outcome.startError !== undefined) {
    return new Error(`${label} could not start: ${outcome.startError}`);
  }
  if (outcome.timedOut) return new Error(`${label} timed out`);
  if (outcome.exitCode !== 0) {
    return new Error(
      `${label} exited with code ${String(outcome.exitCode)}${
        outcome.stderr ? `: ${outcome.stderr.trim()}` : ""
      }`,
    );
  }
  return undefined;
}

async function requireCommand(label: string, argv: readonly string[], cwd?: string): Promise<void> {
  const outcome = await runCommand({ argv, ...(cwd ? { cwd } : {}) }, 120_000);
  const problem = commandFailed(label, outcome);
  if (problem !== undefined) throw problem;
}

export async function checkoutElk(parent = tmpdir(), existing?: string): Promise<ElkCheckout> {
  if (existing !== undefined) {
    const outcome = await runCommand({ argv: ["git", "rev-parse", "HEAD"], cwd: existing }, 30_000);
    const problem = commandFailed("ELK revision lookup", outcome);
    if (problem !== undefined) throw problem;
    if (outcome.stdout.trim() !== ELK_COMMIT) {
      throw new Error(`ELK checkout resolved ${outcome.stdout.trim()} instead of ${ELK_COMMIT}`);
    }
    return { path: existing, dispose: async () => undefined };
  }

  const path = await mkdtemp(join(parent, "rsvite-elk-"));
  try {
    await requireCommand("ELK clone", ["git", "clone", "--no-checkout", ELK_REPOSITORY, path]);
    await requireCommand("ELK checkout", ["git", "checkout", "--detach", ELK_COMMIT], path);
    const outcome = await runCommand({ argv: ["git", "rev-parse", "HEAD"], cwd: path }, 30_000);
    const problem = commandFailed("ELK revision lookup", outcome);
    if (problem !== undefined) throw problem;
    if (outcome.stdout.trim() !== ELK_COMMIT) {
      throw new Error(`ELK checkout resolved ${outcome.stdout.trim()} instead of ${ELK_COMMIT}`);
    }
    return { path, dispose: () => rm(path, { force: true, recursive: true }) };
  } catch (error) {
    await rm(path, { force: true, recursive: true });
    throw error;
  }
}

export async function assertElkSourceUnchanged(projectRoot: string): Promise<void> {
  const outcome = await runCommand(
    { argv: ["git", "status", "--porcelain"], cwd: projectRoot },
    30_000,
  );
  const problem = commandFailed("ELK source status", outcome);
  if (problem !== undefined) throw problem;
  if (outcome.stdout.trim()) {
    throw new Error(`the ELK adapter changed tracked source:\n${outcome.stdout.trim()}`);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    const close = (): void => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("the temporary port listener had no bound address"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(port);
      });
    };
    server.once("error", reject);
    server.listen(0, "127.0.0.1", close);
  });
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    function done(): void {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForExpression(
  page: BrowserPage,
  expression: string,
  signal: AbortSignal,
  description: string,
): Promise<void> {
  const deadline = Date.now() + PAGE_PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(expression, signal)) return;
    } catch (error) {
      if (!String(error).includes("Execution context was destroyed")) throw error;
    }
    await sleep(100, signal);
  }
  let snapshot = "";
  try {
    snapshot = String(
      await page.evaluate(
        `JSON.stringify({ path: location.pathname, text: (document.body?.innerText ?? "").slice(0, 240) })`,
        signal,
      ),
    );
  } catch (error) {
    snapshot = `unavailable: ${String(error)}`;
  }
  throw new Error(`ELK browser acceptance did not reach ${description} (${snapshot})`);
}

const HOME_READY = `(() => {
  const text = document.body?.innerText ?? "";
  return location.pathname === ${JSON.stringify(ELK_HOME_PATH)} &&
    (text.includes("elkdev") || text.includes("Elk Dev"));
})()`;

const EXPLORE_READY = `(() => location.pathname.includes("explore"))()`;

const CLICK_EXPLORE = `(() => {
  const link = [...document.querySelectorAll("a")].find((candidate) =>
    (candidate.getAttribute("href") ?? "").includes("explore"),
  );
  if (!(link instanceof HTMLAnchorElement)) return false;
  link.click();
  return true;
})()`;

const CLICK_HOME = `(() => {
  const link = [...document.querySelectorAll("a")].find(
    (candidate) => candidate.getAttribute("href") === ${JSON.stringify(ELK_HOME_PATH)},
  );
  if (!(link instanceof HTMLAnchorElement)) return false;
  link.click();
  return true;
})()`;

export interface ElkBrowserAdapter extends BrowserAdapter {
  takeColdPhase(): ColdPhase | undefined;
}

export interface ElkBrowserAdapterOptions extends StabilityOptions {
  readonly inner?: BrowserAdapter;
}

export function createElkBrowserAdapter(options: ElkBrowserAdapterOptions = {}): ElkBrowserAdapter {
  const inner = options.inner ?? createChromiumBrowserAdapter();
  const stability: StabilityOptions = {
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.quietObservations !== undefined
      ? { quietObservations: options.quietObservations }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
  };
  let coldPhase: ColdPhase | undefined;

  return {
    takeColdPhase(): ColdPhase | undefined {
      const value = coldPhase;
      coldPhase = undefined;
      return value;
    },
    async open(request): Promise<BrowserPage> {
      if (new URL(request.url).pathname !== ELK_HOME_PATH) {
        return inner.open(request);
      }

      const warmup = await inner.open(request);
      let page: BrowserPage | undefined;
      try {
        await waitForExpression(warmup, HOME_READY, request.signal, "the mocked /home timeline");
        const warmupEvents = await waitForObservedStability(warmup, request.signal, stability);
        await waitForExpression(
          warmup,
          HOME_READY,
          request.signal,
          "the mocked /home timeline after optimize-deps",
        );
        warmupEvents.push(...warmup.drainEvents());
        await warmup.close(request.signal);

        page = await inner.open(request);
        await waitForExpression(
          page,
          HOME_READY,
          request.signal,
          "the mocked /home timeline on the acceptance page",
        );
        const settleEvents = await waitForObservedStability(page, request.signal, stability);
        const coldEvents = [...warmupEvents, ...settleEvents];
        coldPhase = { cacheState: "warm", events: coldEvents };

        await waitForExpression(page, CLICK_EXPLORE, request.signal, "the Explore control");
        await waitForExpression(page, EXPLORE_READY, request.signal, "the Explore page");
        await waitForExpression(page, CLICK_HOME, request.signal, "the Home control");
        await waitForExpression(
          page,
          HOME_READY,
          request.signal,
          "the mocked /home timeline after Explore",
        );
        discardMainFrameNavigations(page);
        await page.evaluate(
          `${ELK_SENTINEL} = globalThis.crypto?.randomUUID?.() ?? String(Date.now())`,
          request.signal,
        );
        return page;
      } catch (error) {
        const cleanup = new AbortController();
        await warmup.close(cleanup.signal).catch(() => undefined);
        if (page !== undefined) await page.close(cleanup.signal).catch(() => undefined);
        throw error;
      }
    },
  };
}

async function updateElk(
  page: BrowserPage,
  signal: AbortSignal,
  projectRoot: string,
): Promise<void> {
  const source = join(projectRoot, ELK_HMR_STYLESHEET);
  const original = await readFile(source, "utf8");
  if (!original.includes(ELK_HMR_FIND)) {
    throw new Error(`ELK HMR stylesheet does not contain the declared find text`);
  }
  await writeFile(source, original.replace(ELK_HMR_FIND, ELK_HMR_REPLACE));
  await sleep(PAGE_SETTLE_MS, signal);
  await waitForExpression(
    page,
    HOME_READY,
    signal,
    "the mocked /home timeline after the Vite update",
  );
}

async function restoreElkStylesheet(projectRoot: string): Promise<void> {
  const source = join(projectRoot, ELK_HMR_STYLESHEET);
  if (!existsSync(source)) return;
  const current = await readFile(source, "utf8");
  if (!current.includes(ELK_HMR_REPLACE)) return;
  await writeFile(source, current.replace(ELK_HMR_REPLACE, ELK_HMR_FIND));
}

async function wipeViteOptimizerCache(projectRoot: string): Promise<void> {
  await rm(join(projectRoot, "node_modules/.cache/vite"), { force: true, recursive: true });
  await rm(join(projectRoot, ".nuxt"), { force: true, recursive: true });
}

function readInstalledVersion(projectRoot: string, packageName: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(projectRoot, "node_modules", packageName, "package.json"), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    try {
      const lockfile = readFileSync(join(projectRoot, "pnpm-lock.yaml"), "utf8");
      const match = lockfile.match(new RegExp(`(?:^|\\n)\\s+${packageName}@([^:\\s(]+):`));
      return match?.[1];
    } catch {
      return undefined;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function annotateElkResult(
  report: RunReport,
  manifest: unknown,
  annotation: {
    readonly viteVersion?: string;
    readonly nuxtVersion?: string;
    readonly nitroVersion?: string;
    readonly coldPhase?: ColdPhase;
    readonly hmrUpdate?: Record<string, unknown>;
    readonly buildOutputs?: readonly string[];
  },
): void {
  const result = asRecord(structuredClone(report.result));
  if (result === undefined) throw new Error("the ELK result is not an object");
  const subject = asRecord(result["subject"]);
  if (subject === undefined) throw new Error("the ELK result has no subject");
  if (annotation.viteVersion !== undefined && subject["name"] === "vite") {
    subject["version"] = annotation.viteVersion;
  }

  const xelk: Record<string, unknown> = {
    ignoredPageError: IGNORED_PAGE_ERROR,
  };
  if (annotation.viteVersion !== undefined) xelk["viteVersion"] = annotation.viteVersion;
  if (annotation.nuxtVersion !== undefined) xelk["nuxtVersion"] = annotation.nuxtVersion;
  if (annotation.nitroVersion !== undefined) xelk["nitroVersion"] = annotation.nitroVersion;
  if (annotation.coldPhase !== undefined) {
    xelk["acceptanceCacheState"] = annotation.coldPhase.cacheState;
    xelk["coldOptimizeDeps"] = summarizeColdPhase(annotation.coldPhase.events);
  }
  if (annotation.hmrUpdate !== undefined) xelk["hmrUpdate"] = annotation.hmrUpdate;
  if (annotation.buildOutputs !== undefined) {
    xelk["buildOutputs"] = [...annotation.buildOutputs];
  }
  result["extensions"] = { "x-elk": xelk };

  const check = createContractValidators().validateResultAgainstManifest(manifest, result);
  if (!check.valid) {
    throw new Error(
      `annotated ELK result failed the contract: ${JSON.stringify(check.violations)}`,
    );
  }
  writeFileSync(report.resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

function assertBuildOutputs(projectRoot: string): string[] {
  const missing = BUILD_OUTPUTS.filter((relative) => !existsSync(join(projectRoot, relative)));
  if (missing.length > 0) {
    throw new Error(`ELK build did not produce ${missing.join(", ")}`);
  }
  return [...BUILD_OUTPUTS];
}

function corepackHome(): string {
  return (
    process.env["COREPACK_HOME"] ??
    join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "node/corepack")
  );
}

export function ensureElkPnpmOnPath(version: string): string {
  execFileSync("corepack", ["install", "-g", `pnpm@${version}`, "--cache-only"], {
    encoding: "utf8",
  });
  const pnpmCjs = join(corepackHome(), "v1", "pnpm", version, "bin", "pnpm.cjs");
  if (!existsSync(pnpmCjs)) {
    throw new Error(`corepack did not cache pnpm@${version} at ${pnpmCjs}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "rsvite-elk-pnpm-"));
  const wrapper = join(dir, "pnpm");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(pnpmCjs)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  process.env["PATH"] = `${dir}${delimiter}${process.env["PATH"] ?? ""}`;
  return execFileSync(process.execPath, [pnpmCjs, "--version"], {
    encoding: "utf8",
    cwd: dir,
  }).trim();
}

function runEnvironmentForLifecycle(
  environment: RunEnvironment,
  projectRoot: string,
  artifactRoot: string,
  subject: ElkSubject,
  lifecycle: "dev" | "build" | "preview",
  rsviteCommand?: readonly string[],
) {
  return async (): Promise<RunReport> => {
    const port = await freePort();
    const manifest = createElkManifest({
      lifecycle,
      pnpmVersion: environment.packageManager.version,
      port,
      subject,
      ...(rsviteCommand ? { rsviteCommand } : {}),
    });
    const browser = lifecycle === "build" ? undefined : createElkBrowserAdapter();
    const viteVersion = readInstalledVersion(projectRoot, "vite");
    const report = await runCompatibilityCheck({
      manifest,
      entryId: ELK_ENTRY_ID,
      lifecycle,
      subject: {
        name: subject,
        version:
          subject === "vite"
            ? (viteVersion ?? readInstalledVersion(projectRoot, "vite") ?? "unknown")
            : "workspace-unavailable",
      },
      environment,
      projectRoot,
      artifactRoot,
      origin: lifecycle === "build" ? undefined : `http://127.0.0.1:${String(port)}`,
      declared: declaredElkRun(subject, lifecycle),
      ...(browser ? { browser } : {}),
      ...(lifecycle === "dev" && subject === "vite"
        ? {
            update: (page: BrowserPage, signal: AbortSignal) =>
              updateElk(page, signal, projectRoot),
          }
        : {}),
      timeouts: {
        installMs: INSTALL_TIMEOUT_MS,
        lifecycleMs: LIFECYCLE_TIMEOUT_MS,
        browserMs: BROWSER_TIMEOUT_MS,
      },
    });
    await restoreElkStylesheet(projectRoot);
    const measuredVite = readInstalledVersion(projectRoot, "vite") ?? viteVersion;
    annotateElkResult(report, manifest, {
      ...(measuredVite !== undefined ? { viteVersion: measuredVite } : {}),
      ...(readInstalledVersion(projectRoot, "nuxt") !== undefined
        ? { nuxtVersion: readInstalledVersion(projectRoot, "nuxt") }
        : {}),
      ...(readInstalledVersion(projectRoot, "nitropack") !== undefined
        ? { nitroVersion: readInstalledVersion(projectRoot, "nitropack") }
        : {}),
      ...(browser !== undefined ? { coldPhase: browser.takeColdPhase() } : {}),
      ...(lifecycle === "dev" && subject === "vite"
        ? {
            hmrUpdate: {
              path: ELK_HMR_STYLESHEET,
              kind: "content-replace",
              find: ELK_HMR_FIND,
              replace: ELK_HMR_REPLACE,
              reverted: true,
            },
          }
        : {}),
      ...(lifecycle === "build" && subject === "vite" && report.failure === undefined
        ? { buildOutputs: assertBuildOutputs(projectRoot) }
        : {}),
    });
    return report;
  };
}

export async function runElkViteBaseline(options: ElkRunOptions): Promise<ElkViteBaseline> {
  const checkout = await checkoutElk(options.checkoutParent, options.existingCheckout);
  try {
    await wipeViteOptimizerCache(checkout.path);
    const dev = await runEnvironmentForLifecycle(
      options.environment,
      checkout.path,
      join(options.artifactRoot, "vite/dev"),
      "vite",
      "dev",
    )();
    await assertElkSourceUnchanged(checkout.path);
    const build = await runEnvironmentForLifecycle(
      options.environment,
      checkout.path,
      join(options.artifactRoot, "vite/build"),
      "vite",
      "build",
    )();
    await assertElkSourceUnchanged(checkout.path);
    const preview = await runEnvironmentForLifecycle(
      options.environment,
      checkout.path,
      join(options.artifactRoot, "vite/preview"),
      "vite",
      "preview",
    )();
    await assertElkSourceUnchanged(checkout.path);
    return { dev, build, preview };
  } finally {
    await checkout.dispose();
  }
}

export async function runElkRsviteIncompatibility(options: ElkRunOptions): Promise<RunReport> {
  const checkout = await checkoutElk(options.checkoutParent, options.existingCheckout);
  try {
    const report = await runEnvironmentForLifecycle(
      options.environment,
      checkout.path,
      join(options.artifactRoot, "rsvite/dev"),
      "rsvite",
      "dev",
      options.rsviteCommand,
    )();
    await assertElkSourceUnchanged(checkout.path);
    if (report.failure === undefined) {
      throw new Error(
        "the current rsvite ELK run unexpectedly passed without an implemented package path",
      );
    }
    return report;
  } finally {
    await checkout.dispose();
  }
}

export async function runElkEvidence(options: ElkRunOptions): Promise<ElkEvidence> {
  const baseline = await runElkViteBaseline(options);
  const rsvite = await runElkRsviteIncompatibility(options);
  return { ...baseline, rsvite };
}

export async function createElkEnvironment(
  runnerImage = process.env["RUNNER_IMAGE"] ?? "local",
): Promise<RunEnvironment> {
  const version = ensureElkPnpmOnPath(ELK_PNPM_VERSION);
  if (version !== ELK_PNPM_VERSION) {
    throw new Error(`pnpm --version is ${version}, expected ${ELK_PNPM_VERSION}`);
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`host is ${process.platform}/${process.arch}, expected linux/x64`);
  }
  return {
    os: process.platform,
    arch: process.arch,
    runnerImage,
    nodeVersion: process.version.slice(1),
    packageManager: { name: "pnpm", version },
    browser: { name: "chromium", version: await chromiumVersion() },
  };
}
