import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  DRAWDB_HMR_UPDATE_COUNTER,
} from "./chromium.ts";
import {
  createDrawDbManifest,
  declaredDrawDbRun,
  DRAWDB_COMMIT,
  DRAWDB_ENTRY_ID,
  DRAWDB_REPOSITORY,
  DRAWDB_SENTINEL,
  drawDbCommandEnvironment,
  drawDbHmrEdit,
  drawDbNpmVersion,
  rsviteWorkspaceVersion,
  type DrawDbRun,
} from "./manifest.ts";

const INSTALL_TIMEOUT_MS = 600_000;
const LIFECYCLE_TIMEOUT_MS = 300_000;
const BROWSER_TIMEOUT_MS = 60_000;
const PAGE_SETTLE_MS = 750;
const PAGE_PROBE_TIMEOUT_MS = 30_000;

interface DrawDbCheckout {
  readonly path: string;
  dispose(): Promise<void>;
}

interface DrawDbViteBaseline {
  readonly dev: RunReport;
  readonly build: RunReport;
  readonly preview: RunReport;
}

interface DrawDbEvidence extends DrawDbViteBaseline {
  readonly rsvite: RunReport;
}

interface DrawDbRunOptions {
  readonly artifactRoot: string;
  readonly environment: RunEnvironment;
}

function commandFailed(
  label: string,
  outcome: Awaited<ReturnType<typeof runCommand>>,
): Error | undefined {
  if (outcome.startError !== undefined)
    return new Error(`${label} could not start: ${outcome.startError}`);
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

async function checkoutDrawDb(): Promise<DrawDbCheckout> {
  const path = await mkdtemp(join(tmpdir(), "rsvite-drawdb-"));
  try {
    await requireCommand("DrawDB clone", [
      "git",
      "clone",
      "--no-checkout",
      DRAWDB_REPOSITORY,
      path,
    ]);
    await requireCommand("DrawDB checkout", ["git", "checkout", "--detach", DRAWDB_COMMIT], path);
    const outcome = await runCommand({ argv: ["git", "rev-parse", "HEAD"], cwd: path }, 30_000);
    const problem = commandFailed("DrawDB revision lookup", outcome);
    if (problem !== undefined) throw problem;
    if (outcome.stdout.trim() !== DRAWDB_COMMIT) {
      throw new Error(
        `DrawDB checkout resolved ${outcome.stdout.trim()} instead of ${DRAWDB_COMMIT}`,
      );
    }
    return { path, dispose: () => rm(path, { force: true, recursive: true }) };
  } catch (error) {
    await rm(path, { force: true, recursive: true });
    throw error;
  }
}

async function assertDrawDbSourceUnchanged(projectRoot: string): Promise<void> {
  const outcome = await runCommand(
    { argv: ["git", "status", "--porcelain"], cwd: projectRoot },
    30_000,
  );
  const problem = commandFailed("DrawDB source status", outcome);
  if (problem !== undefined) throw problem;
  if (outcome.stdout.trim()) {
    throw new Error(`the DrawDB adapter changed tracked source:\n${outcome.stdout.trim()}`);
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
    if (await page.evaluate(expression, signal)) return;
    await sleep(100, signal);
  }
  throw new Error(`DrawDB browser acceptance did not reach ${description}`);
}

const EDITOR_READY = `(() => {
  const text = document.body?.innerText ?? "";
  return text.includes("Add table") && text.includes("No tables");
})()`;

const ADD_SAMPLE_TABLE = `(() => {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Add table",
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error("DrawDB Add table control is absent");
  button.click();
  return true;
})()`;

const SAMPLE_TABLE_PRESENT = '(() => (document.body?.innerText ?? "").includes("table_"))()';
const SAMPLE_TABLE_ROUTE = '(() => window.location.pathname.startsWith("/editor/diagrams/"))()';
const HMR_PROBE_PROPERTY = "--rsvite-drawdb-hmr-probe";
const HMR_PROBE_VALUE = "active";
const HMR_UPDATE_COUNT = `globalThis.${DRAWDB_HMR_UPDATE_COUNTER}`;
const HMR_VISIBLE_PROBE = `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(
  HMR_PROBE_PROPERTY,
)}).trim()`;
const HMR_CHANGED_STATE = `${HMR_VISIBLE_PROBE} === ${JSON.stringify(HMR_PROBE_VALUE)}`;
const HMR_RESTORED_STATE = `${HMR_VISIBLE_PROBE} === ""`;

function createDrawDbBrowserAdapter(): BrowserAdapter {
  const chromium = createChromiumBrowserAdapter();
  return {
    async open(request): Promise<BrowserPage> {
      const page = await chromium.open(request);
      try {
        await waitForExpression(page, EDITOR_READY, request.signal, "the DrawDB editor");
        await page.evaluate(ADD_SAMPLE_TABLE, request.signal);
        await waitForExpression(
          page,
          SAMPLE_TABLE_PRESENT,
          request.signal,
          "the sample table created in the editor",
        );
        await waitForExpression(
          page,
          SAMPLE_TABLE_ROUTE,
          request.signal,
          "the saved sample-table editor route",
        );
        // React Router updates this route asynchronously after the table is persisted. Let its
        // navigation event settle before the runner opens the HMR update window.
        await sleep(PAGE_SETTLE_MS, request.signal);
        await page.evaluate(
          `${DRAWDB_SENTINEL} = globalThis.crypto?.randomUUID?.() ?? String(Date.now())`,
          request.signal,
        );
        return page;
      } catch (error) {
        const cleanup = new AbortController();
        await page.close(cleanup.signal).catch(() => undefined);
        throw error;
      }
    },
  };
}

export async function updateDrawDbStylesheet(
  page: BrowserPage,
  signal: AbortSignal,
  projectRoot: string,
): Promise<void> {
  const hmrEdit = drawDbHmrEdit();
  const source = join(projectRoot, hmrEdit.path);
  const original = await readFile(source, "utf8");
  const changed = original.replace(hmrEdit.find, hmrEdit.replace);
  if (changed === original) throw new Error("DrawDB stylesheet has no HMR probe insertion point");

  const counter = await page.evaluate(HMR_UPDATE_COUNT, signal);
  if (typeof counter !== "number") throw new Error("DrawDB page has no Vite HMR update counter");

  let counterBeforeRestoration: number | undefined;
  await writeFile(source, changed);
  try {
    await waitForExpression(
      page,
      `${HMR_UPDATE_COUNT} > ${String(counter)}`,
      signal,
      "the DrawDB stylesheet HMR update",
    );
    await waitForExpression(page, HMR_CHANGED_STATE, signal, "the changed DrawDB stylesheet state");
    // Keep the changed file through one settle window so Vite cannot coalesce its restoration
    // with the update the browser just observed.
    await sleep(PAGE_SETTLE_MS, signal);
    const observed = await page.evaluate(HMR_UPDATE_COUNT, signal);
    if (typeof observed !== "number") {
      throw new Error("DrawDB page lost its Vite HMR update counter");
    }
    counterBeforeRestoration = observed;
  } finally {
    await writeFile(source, original);
  }
  if (counterBeforeRestoration === undefined) {
    throw new Error("DrawDB did not observe its stylesheet HMR update before restoration");
  }
  await waitForExpression(
    page,
    `${HMR_UPDATE_COUNT} > ${String(counterBeforeRestoration)}`,
    signal,
    "the restored DrawDB stylesheet HMR update",
  );
  await waitForExpression(page, HMR_RESTORED_STATE, signal, "the restored DrawDB stylesheet state");
  await sleep(PAGE_SETTLE_MS, signal);
  await waitForExpression(
    page,
    SAMPLE_TABLE_PRESENT,
    signal,
    "the sample table after the Vite update",
  );
}

function runEnvironmentForLifecycle(
  environment: RunEnvironment,
  projectRoot: string,
  artifactRoot: string,
  run: DrawDbRun,
) {
  return async (): Promise<RunReport> => {
    const port = await freePort();
    const manifest = createDrawDbManifest({
      port,
      ...run,
    });
    const browser = run.lifecycle === "build" ? undefined : createDrawDbBrowserAdapter();
    return runCompatibilityCheck({
      manifest,
      entryId: DRAWDB_ENTRY_ID,
      lifecycle: run.lifecycle,
      subject: {
        name: run.subject,
        version: run.subject === "vite" ? "8.1.0" : rsviteWorkspaceVersion(),
      },
      environment,
      projectRoot,
      artifactRoot,
      origin: run.lifecycle === "build" ? undefined : `http://127.0.0.1:${String(port)}`,
      declared: declaredDrawDbRun(run),
      ...(browser ? { browser } : {}),
      ...(run.lifecycle === "dev"
        ? {
            update: (page: BrowserPage, signal: AbortSignal) =>
              updateDrawDbStylesheet(page, signal, projectRoot),
          }
        : {}),
      timeouts: {
        installMs: INSTALL_TIMEOUT_MS,
        lifecycleMs: LIFECYCLE_TIMEOUT_MS,
        browserMs: BROWSER_TIMEOUT_MS,
      },
    });
  };
}

async function runDrawDbViteBaseline(options: DrawDbRunOptions): Promise<DrawDbViteBaseline> {
  const checkout = await checkoutDrawDb();
  try {
    const dev = await runEnvironmentForLifecycle(
      options.environment,
      checkout.path,
      join(options.artifactRoot, "vite", "dev"),
      { subject: "vite", lifecycle: "dev" },
    )();
    await assertDrawDbSourceUnchanged(checkout.path);
    const build = await runEnvironmentForLifecycle(
      options.environment,
      checkout.path,
      join(options.artifactRoot, "vite", "build"),
      { subject: "vite", lifecycle: "build" },
    )();
    await assertDrawDbSourceUnchanged(checkout.path);
    const preview = await runEnvironmentForLifecycle(
      options.environment,
      checkout.path,
      join(options.artifactRoot, "vite", "preview"),
      { subject: "vite", lifecycle: "preview" },
    )();
    await assertDrawDbSourceUnchanged(checkout.path);
    return { dev, build, preview };
  } finally {
    await checkout.dispose();
  }
}

async function runDrawDbRsviteIncompatibility(options: DrawDbRunOptions): Promise<RunReport> {
  const checkout = await checkoutDrawDb();
  try {
    const report = await runEnvironmentForLifecycle(
      options.environment,
      checkout.path,
      join(options.artifactRoot, "rsvite", "dev"),
      { subject: "rsvite", lifecycle: "dev" },
    )();
    await assertDrawDbSourceUnchanged(checkout.path);
    if (report.failure === undefined) {
      throw new Error("the rsvite incompatibility record must report a failure");
    }
    return report;
  } finally {
    await checkout.dispose();
  }
}

/** This explicit recording operation clones and exercises the external DrawDB project. */
export async function recordDrawDbEvidence(options: {
  readonly artifactRoot: string;
}): Promise<DrawDbEvidence> {
  const runOptions: DrawDbRunOptions = {
    artifactRoot: options.artifactRoot,
    environment: await createDrawDbEnvironment(),
  };
  const baseline = await runDrawDbViteBaseline(runOptions);
  const rsvite = await runDrawDbRsviteIncompatibility(runOptions);
  return { ...baseline, rsvite };
}

async function currentNpmVersion(): Promise<string> {
  const outcome = await runCommand(
    { argv: ["npm", "--version"], env: drawDbCommandEnvironment() },
    30_000,
  );
  const problem = commandFailed("npm version lookup", outcome);
  if (problem !== undefined) throw problem;
  const version = outcome.stdout.trim();
  if (!version) throw new Error("npm version lookup returned no version");
  return version;
}

async function createDrawDbEnvironment(
  runnerImage = process.env["RUNNER_IMAGE"] ?? "local",
): Promise<RunEnvironment> {
  const npmVersion = await currentNpmVersion();
  const expectedNpmVersion = drawDbNpmVersion();
  if (npmVersion !== expectedNpmVersion) {
    throw new Error(
      `DrawDB requires npm ${expectedNpmVersion}, but this run found npm ${npmVersion}`,
    );
  }
  return {
    os: process.platform,
    arch: process.arch,
    runnerImage,
    nodeVersion: process.version.slice(1),
    packageManager: { name: "npm", version: npmVersion },
    browser: { name: "chromium", version: await chromiumVersion() },
  };
}
