// Records the Actual Budget corpus evidence against one pinned checkout: the Vite baseline for
// the lifecycles the entry requires, and what rsvite currently does with the same input.
//
// Inputs, all of which the recording declares rather than assumes:
//   ACTUAL_BUDGET_CHECKOUT  required. A clean git checkout at the commit `pin.json` names.
//   RUNNER_IMAGE            required. How this environment is identified in the result, so two
//                           results are only comparable when they say they were produced alike.
//   RECORD_SUBJECTS         optional. "both" (default), "vite" or "rsvite".
//
// The pinned checkout's own Chromium is started once before the baseline, and installed through
// the project's own Playwright if it is not there yet. See ../README.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LifecycleName, RunEnvironment } from "@rsvite/compatibility-runner";
import {
  actualBudgetCommands,
  actualBudgetReadiness,
  devOrigin,
  readPin,
  rsviteCommands,
  rsviteDeclaration,
  upstreamE2eCommand,
  viteDeclaration,
} from "../src/index.ts";
import { assertPinnedInputs, prepareTranslations } from "../src/translations.ts";
import { createPlaywrightBrowser, readBrowserVersion } from "../src/browser.ts";
import { manifestForRun, record, waitForText, type Recording } from "../src/record.ts";
import { runUpstreamOrThrow } from "../src/upstream.ts";

const INSTALL_MS = 900_000;
const BUILD_MS = 1_200_000;
const DEV_MS = 1_800_000;
const UPSTREAM_SPEC_MS = 900_000;
const BROWSER_INSTALL_MS = 900_000;

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const checkout = required("ACTUAL_BUDGET_CHECKOUT");
const runnerImage = required("RUNNER_IMAGE");
const subjects = process.env["RECORD_SUBJECTS"] ?? "both";

const pin = readPin();
const manifest: unknown = JSON.parse(readFileSync(join(repoRoot, "corpus/manifest.json"), "utf8"));
const resultsRoot = join(repoRoot, "corpus/results", pin.entryId);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`set ${name}: the recording declares its inputs rather than guessing them`);
  }
  return value;
}

const verifyInputs = (): void => {
  assertPinnedInputs(checkout, pin);
};

function environment(browser?: { name: string; version: string }): RunEnvironment {
  return {
    os: process.platform,
    arch: process.arch,
    runnerImage,
    nodeVersion: process.versions.node,
    packageManager: pin.lockfile.packageManager,
    ...(browser === undefined ? {} : { browser }),
  };
}

function roots(subject: string, lifecycle: LifecycleName) {
  return {
    publishRoot: join(resultsRoot, subject, lifecycle),
    stagingRoot: join(resultsRoot, subject, `${lifecycle}.recording`),
  };
}

/**
 * The version of the browser that will actually run — asked of a launched browser, because the
 * Playwright library's own version is a different number and recording it would describe
 * something no run ever used. A missing browser is installed rather than assumed.
 */
async function prepareBrowser(): Promise<string> {
  try {
    return await readBrowserVersion(checkout);
  } catch (missing) {
    await runUpstreamOrThrow({
      label: "the project's own browser install",
      command: {
        argv: [
          "corepack",
          "yarn",
          "workspace",
          "@actual-app/web",
          "playwright",
          "install",
          "chromium",
        ],
        cwd: checkout,
      },
      timeoutMs: BROWSER_INSTALL_MS,
    });
    try {
      return await readBrowserVersion(checkout);
    } catch (stillMissing) {
      throw new Error(
        `the pinned checkout has no usable Chromium: ${String(stillMissing)} (before installing: ${String(missing)})`,
      );
    }
  }
}

/** rsvite against the same input: the project's own lifecycle, driven by rsvite instead of Vite. */
async function recordRsviteDev(): Promise<Recording> {
  return record({
    checkoutRoot: checkout,
    manifest: manifestForRun(manifest, pin.entryId, {
      commands: rsviteCommands(repoRoot, pin),
      readiness: actualBudgetReadiness("dev"),
    }),
    entryId: pin.entryId,
    lifecycle: "dev",
    subject: { name: "rsvite", version: "0.0.0" },
    // No browser is named: none was launched, and naming one would describe a step that never
    // happened.
    environment: environment(),
    declared: rsviteDeclaration(),
    ...roots("rsvite", "dev"),
    origin: devOrigin(pin),
    verifyInputs,
    timeouts: { installMs: INSTALL_MS, lifecycleMs: 300_000, browserMs: 60_000 },
  });
}

/**
 * The production build as its own recorded lifecycle rather than a step beside one. The entry
 * requires `build-output`, and a raw log next to a development result cannot claim it: one result
 * describes one lifecycle command, and the entry's coverage is what the results establish together.
 */
async function recordViteBuild(): Promise<Recording> {
  return record({
    checkoutRoot: checkout,
    manifest: manifestForRun(manifest, pin.entryId, {
      commands: actualBudgetCommands(pin),
      readiness: actualBudgetReadiness("build"),
    }),
    entryId: pin.entryId,
    lifecycle: "build",
    subject: { name: "vite", version: viteVersion() },
    environment: environment(),
    declared: viteDeclaration("build"),
    ...roots("vite", "build"),
    verifyInputs,
    // The project's own build prunes the languages it does not ship, which leaves the pinned
    // translations checkout changed. The pin goes back before the inputs are verified.
    restore: () => prepareTranslations(checkout, pin),
    timeouts: { installMs: INSTALL_MS, lifecycleMs: BUILD_MS, browserMs: 60_000 },
  });
}

/** The development baseline: the project's own server, its own spec against it, then one update. */
async function recordViteDev(browserVersion: string): Promise<Recording> {
  const { publishRoot, stagingRoot } = roots("vite", "dev");

  return record({
    checkoutRoot: checkout,
    manifest: manifestForRun(manifest, pin.entryId, {
      commands: actualBudgetCommands(pin),
      readiness: actualBudgetReadiness("dev"),
    }),
    entryId: pin.entryId,
    lifecycle: "dev",
    subject: { name: "vite", version: viteVersion() },
    environment: environment({ name: "chromium", version: browserVersion }),
    declared: viteDeclaration("dev"),
    publishRoot,
    stagingRoot,
    origin: devOrigin(pin),
    browser: createPlaywrightBrowser(checkout),
    verifyInputs,
    update: async (page, signal, hmr) => {
      // The project's own acceptance first: an update measured against a server the application
      // never worked on would be measuring nothing.
      await runUpstreamOrThrow(
        {
          label: "the project's own onboarding spec",
          command: { ...upstreamE2eCommand(devOrigin(pin), pin), cwd: checkout },
          timeoutMs: UPSTREAM_SPEC_MS,
          logs: {
            stdout: join(stagingRoot, "upstream-e2e.stdout.log"),
            stderr: join(stagingRoot, "upstream-e2e.stderr.log"),
          },
        },
        signal,
      );
      // Then the exact manifest-declared source edit, which the development server is expected to
      // patch into the running document rather than replace it.
      await hmr.apply();
      await waitForText(page, hmr.expectedText, signal);
    },
    timeouts: { installMs: INSTALL_MS, lifecycleMs: DEV_MS, browserMs: 600_000 },
  });
}

function viteVersion(): string {
  const path = join(checkout, "node_modules/vite/package.json");
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
  } catch {
    throw new Error(`install the checkout first: the resolved Vite version is read from ${path}`);
  }
}

// The build reads a checkout that lives inside the project but outside its history. Putting the
// pinned revision in place — and making the project's own `git pull` unable to move it — happens
// before any run, so every recording below is about the same input.
await prepareTranslations(checkout, pin);

const recorded: Record<string, Recording> = {};
if (subjects === "both" || subjects === "rsvite") {
  recorded["rsvite:dev"] = await recordRsviteDev();
}
if (subjects === "both" || subjects === "vite") {
  const browserVersion = await prepareBrowser();
  recorded["vite:build"] = await recordViteBuild();
  recorded["vite:dev"] = await recordViteDev(browserVersion);
}
console.log(JSON.stringify(recorded, null, 2));
