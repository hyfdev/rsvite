// Records the Vite baseline for the pinned Actual Budget checkout by driving the project's own
// development server, onboarding E2E spec and browser build through the canonical runner.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCompatibilityCheck } from "@rsvite/compatibility-runner";
import { assertPinnedCheckout, devOrigin, readPin, upstreamE2eCommand } from "../src/index.ts";
import { createPlaywrightBrowser } from "../src/browser.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const checkout = process.env["ACTUAL_BUDGET_CHECKOUT"];
if (checkout === undefined) {
  throw new Error("set ACTUAL_BUDGET_CHECKOUT to the pinned Actual Budget checkout");
}

const pin = readPin();
assertPinnedCheckout(checkout, pin);

const manifest = JSON.parse(readFileSync(join(repoRoot, "corpus/manifest.json"), "utf8")) as {
  entries: { id: string }[];
};
const artifactRoot = join(repoRoot, "corpus/results", pin.entryId, "vite");
await mkdir(artifactRoot, { recursive: true });

const editPath = join(checkout, pin.sentinelEditPath);
const original = readFileSync(editPath, "utf8");

/** Runs the project's own spec against the server the runner started. */
function runUpstreamSpec(origin: string): void {
  const command = upstreamE2eCommand(origin, pin);
  const [file, ...args] = command.argv;
  execFileSync(file as string, args, {
    cwd: checkout,
    env: { ...process.env, ...command.env },
    stdio: "inherit",
  });
}

try {
  const report = await runCompatibilityCheck({
    manifest,
    entryId: pin.entryId,
    lifecycle: "dev",
    subject: { name: "vite", version: viteVersion(checkout) },
    environment: {
      os: process.platform,
      arch: process.arch,
      runnerImage: process.env["RUNNER_IMAGE"] ?? "local",
      nodeVersion: process.versions.node,
      packageManager: pin.lockfile.packageManager,
      browser: { name: "chromium", version: chromiumVersion(checkout) },
    },
    projectRoot: checkout,
    artifactRoot,
    origin: devOrigin(pin),
    declared: {
      javascriptApiLevel: "C1",
      capabilityOwners: [
        "html",
        "modules-and-assets",
        "resolution",
        "file-watching",
        "hmr-without-full-reload",
      ].map((capability) => ({ capability, owner: "vite" })),
      explicitFallbacks: [],
      classifyFailure: (failure) => ({
        kind: "current-compatibility-requirement",
        evidence: `The original Vite baseline failed during ${failure.phase}, so the input itself is not usable as a gate until this is understood.`,
      }),
    },
    browser: createPlaywrightBrowser(checkout),
    update: async (page, signal) => {
      // The project's own acceptance first: it must still pass against the runner's server.
      runUpstreamSpec(devOrigin(pin));
      // Then one source edit, which the development server is expected to patch into the
      // running document rather than replace it.
      writeFileSync(editPath, original.replace(pin.sentinelEdit.find, pin.sentinelEdit.replace));
      await waitForText(page, pin.sentinelEdit.expectedText, signal);
    },
    timeouts: { installMs: 900_000, lifecycleMs: 900_000, browserMs: 300_000 },
  });

  execFileSync("corepack", ["yarn", "build:browser"], { cwd: checkout, stdio: "inherit" });

  console.log(JSON.stringify({ resultPath: report.resultPath, failure: report.failure }, null, 2));
} finally {
  // The checkout is evidence only while it is the pinned one; the edit never outlives the run.
  writeFileSync(editPath, original);
}

async function waitForText(
  page: { evaluate: (expression: string, signal: AbortSignal) => Promise<unknown> },
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("the update was aborted");
    const found = await page.evaluate(
      `document.body.innerText.includes(${JSON.stringify(text)})`,
      signal,
    );
    if (found === true) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the update never produced ${JSON.stringify(text)}`);
}

function viteVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "node_modules/vite/package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

function chromiumVersion(root: string): string {
  const pkg = JSON.parse(
    readFileSync(join(root, "node_modules/playwright-core/package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}
