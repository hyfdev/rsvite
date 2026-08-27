import { mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCompatibilityCheck } from "@rsvite/compatibility-runner";
import {
  HTML_PRESERVE_COMMENTS_ENTRY_ID,
  VITE_UPSTREAM_COMMIT,
  assertCleanGitWorktree,
  assertLinuxX64Host,
  assertPinnedCleanViteCheckout,
  assertPnpmVersion,
  ensureManifestPnpmOnPath,
  htmlPreserveCommentsAdapter,
  htmlPreserveCommentsCommandExecutable,
  htmlPreserveCommentsPackageManager,
  preparePinnedViteCheckout,
  publishViteUpstreamBrowserObservation,
  readViteChromiumVersion,
  readCorpusManifest,
  viteBaselineDir,
} from "../src/index.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must identify this recording's pinned input`);
  }
  return value;
}

const checkout = required("VITE_CHECKOUT");
const runnerImage = required("RUNNER_IMAGE");

const host = assertLinuxX64Host();
const packageManager = htmlPreserveCommentsPackageManager();
const installExecutable = htmlPreserveCommentsCommandExecutable("install");
const testExecutable = htmlPreserveCommentsCommandExecutable("test");
if (installExecutable !== testExecutable) {
  throw new Error(`install uses ${installExecutable} but test uses ${testExecutable}`);
}
if (testExecutable !== packageManager.name) {
  throw new Error(`commands start with ${testExecutable}, lockfile is ${packageManager.name}`);
}

assertPinnedCleanViteCheckout(checkout);
ensureManifestPnpmOnPath(packageManager.version);
const pnpmVersion = assertPnpmVersion(testExecutable, packageManager.version, { cwd: checkout });
preparePinnedViteCheckout(checkout);
const browserVersion = await readViteChromiumVersion(checkout);

const packageJson = JSON.parse(
  readFileSync(join(checkout, "packages/vite/package.json"), "utf8"),
) as {
  version: string;
};

const manifest = readCorpusManifest();
await rm(viteBaselineDir, { recursive: true, force: true });
await mkdir(viteBaselineDir, { recursive: true });

const report = await runCompatibilityCheck({
  manifest,
  entryId: HTML_PRESERVE_COMMENTS_ENTRY_ID,
  lifecycle: "test",
  subject: {
    name: "vite",
    version: packageJson.version,
    commit: VITE_UPSTREAM_COMMIT,
  },
  environment: {
    os: host.os,
    arch: host.arch,
    runnerImage,
    nodeVersion: process.version.slice(1),
    packageManager: { name: packageManager.name, version: pnpmVersion },
    browser: { name: "chromium", version: browserVersion },
  },
  projectRoot: checkout,
  artifactRoot: viteBaselineDir,
  declared: {
    javascriptApiLevel: "C2",
    capabilityOwners: [{ capability: "html", owner: "vite" }],
    explicitFallbacks: [],
    classifyFailure: (failure) => ({
      kind: "current-compatibility-requirement",
      evidence: `Vite failed ${htmlPreserveCommentsAdapter.testName} during ${failure.phase}`,
    }),
  },
  timeouts: { installMs: 600_000, lifecycleMs: 900_000, browserMs: 60_000 },
});

const result = publishViteUpstreamBrowserObservation(report, manifest) as { outcome: string };
if (result.outcome !== "pass") {
  throw new Error(`Vite baseline was ${result.outcome}: ${JSON.stringify(report.failure)}`);
}

assertCleanGitWorktree(checkout);
process.stdout.write(`${report.resultPath}\n`);
