// Records the Actual Budget corpus evidence for both subjects against one pinned checkout.
//
// Inputs, all of which the recording declares rather than assumes:
//   ACTUAL_BUDGET_CHECKOUT  required. A clean git checkout at the commit `pin.json` names.
//   RUNNER_IMAGE            required. How this environment is identified in the result, so two
//                           results are only comparable when they say they were produced alike.
//   RECORD_SUBJECTS         optional. "both" (default), "vite" or "rsvite".
//
// The pinned checkout's own Chromium is started once before the baseline, and installed through
// the project's own Playwright if it is not there yet. See ../README.md.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEnvironment } from "@rsvite/compatibility-runner";
import {
  actualBudgetCommands,
  devOrigin,
  readPin,
  rsviteCommands,
  rsviteDeclaration,
  upstreamE2eCommand,
  viteDeclaration,
  type Pin,
} from "../src/index.ts";
import { createPlaywrightBrowser, readBrowserVersion } from "../src/browser.ts";
import { manifestForSubject, record, waitForText, type Recording } from "../src/record.ts";
import { runUpstreamOrThrow } from "../src/upstream.ts";

const INSTALL_MS = 900_000;
const BUILD_MS = 1_200_000;
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

function roots(subject: string): { publishRoot: string; stagingRoot: string } {
  return {
    publishRoot: join(resultsRoot, subject),
    stagingRoot: join(resultsRoot, `${subject}.recording`),
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

/** rsvite against the same input: the project's own commands, run by rsvite instead of Vite. */
async function recordRsvite(): Promise<Recording> {
  return record({
    checkoutRoot: checkout,
    manifest: manifestForSubject(manifest, pin.entryId, rsviteCommands(repoRoot, pin)),
    pin,
    entryId: pin.entryId,
    lifecycle: "dev",
    subject: { name: "rsvite", version: "0.0.0" },
    // No browser is named: none was launched, and naming one would describe a step that never
    // happened.
    environment: environment(),
    declared: rsviteDeclaration(),
    ...roots("rsvite"),
    origin: devOrigin(pin),
    timeouts: { installMs: INSTALL_MS, lifecycleMs: 300_000, browserMs: 60_000 },
  });
}

/** The Vite baseline: the project's own build, then its own spec, then one update. */
async function recordVite(pinned: Pin, browserVersion: string): Promise<Recording> {
  const { publishRoot, stagingRoot } = roots("vite");
  const editPath = join(checkout, pinned.sentinelEditPath);
  const original = readFileSync(editPath, "utf8");
  const build = actualBudgetCommands(pinned)["build"];
  if (build === undefined) throw new Error("the adapter names no build command for this project");

  return record({
    checkoutRoot: checkout,
    manifest,
    pin: pinned,
    entryId: pinned.entryId,
    lifecycle: "dev",
    subject: { name: "vite", version: viteVersion() },
    environment: environment({ name: "chromium", version: browserVersion }),
    declared: viteDeclaration(),
    publishRoot,
    stagingRoot,
    origin: devOrigin(pinned),
    browser: createPlaywrightBrowser(checkout),
    // The project's own production build has to hold before any of this is evidence, so it runs
    // before the result exists rather than after it has already been written.
    preconditions: [
      {
        label: "the project's own browser build",
        command: { ...build, cwd: checkout },
        timeoutMs: BUILD_MS,
        logs: {
          stdout: join(stagingRoot, "upstream-build.stdout.log"),
          stderr: join(stagingRoot, "upstream-build.stderr.log"),
        },
      },
    ],
    update: async (page, signal) => {
      // The project's own acceptance first: an update measured against a server the application
      // never worked on would be measuring nothing.
      await runUpstreamOrThrow(
        {
          label: "the project's own onboarding spec",
          command: { ...upstreamE2eCommand(devOrigin(pinned), pinned), cwd: checkout },
          timeoutMs: UPSTREAM_SPEC_MS,
          logs: {
            stdout: join(stagingRoot, "upstream-e2e.stdout.log"),
            stderr: join(stagingRoot, "upstream-e2e.stderr.log"),
          },
        },
        signal,
      );
      // Then one source edit, which the development server is expected to patch into the running
      // document rather than replace it.
      writeFileSync(
        editPath,
        original.replace(pinned.sentinelEdit.find, pinned.sentinelEdit.replace),
      );
      await waitForText(page, pinned.sentinelEdit.expectedText, signal);
    },
    restore: () => Promise.resolve(writeFileSync(editPath, original)),
    timeouts: { installMs: INSTALL_MS, lifecycleMs: 1_800_000, browserMs: 600_000 },
  });
}

function viteVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(checkout, "node_modules/vite/package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

const recorded: Record<string, Recording> = {};
if (subjects === "both" || subjects === "rsvite") {
  recorded["rsvite"] = await recordRsvite();
}
if (subjects === "both" || subjects === "vite") {
  recorded["vite"] = await recordVite(pin, await prepareBrowser());
}
console.log(JSON.stringify(recorded, null, 2));
