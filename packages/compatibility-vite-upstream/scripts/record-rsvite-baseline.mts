import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertPreparedSubjectIsStillCurrent,
  prepareRsviteWorkspace,
} from "@rsvite/compatibility-rsvite-workspace";
import { runCompatibilityCheck } from "@rsvite/compatibility-runner";
import {
  HTML_PRESERVE_COMMENTS_ENTRY_ID,
  assertExpectedRsviteHtmlPreserveCommentsExecution,
  assertLinuxX64Host,
  assertPinnedCleanViteCheckout,
  assertPnpmVersion,
  ensureManifestPnpmOnPath,
  htmlPreserveCommentsPackageManager,
  manifestForRsviteHtmlPreserveComments,
  publishViteUpstreamBrowserObservation,
  readViteChromiumVersion,
  rsviteBaselineDir,
  rsviteBaselineResultPath,
  viteVitestInstallation,
  vitePlaywrightChromiumModule,
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
const stagingRoot = `${rsviteBaselineDir}.recording`;
// Prepared here, where the recording actually happens: the subject this records is the one this
// process built and validated, not one an earlier step decided and handed along.
const rsviteSubject = prepareRsviteWorkspace().subject;

assertPinnedCleanViteCheckout(checkout);
ensureManifestPnpmOnPath(packageManager.version);
const pnpmVersion = assertPnpmVersion(packageManager.name, packageManager.version, {
  cwd: checkout,
});
const playwrightModule = vitePlaywrightChromiumModule(checkout);
const vitest = viteVitestInstallation(checkout);
const browserVersion = await readViteChromiumVersion(checkout);

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });

try {
  const manifest = manifestForRsviteHtmlPreserveComments(undefined, {
    playwrightModule,
    upstreamRoot: join(checkout, "playground/html"),
    viteCheckout: checkout,
    vitestExecutable: vitest.executable,
  });
  const report = await runCompatibilityCheck({
    manifest,
    entryId: HTML_PRESERVE_COMMENTS_ENTRY_ID,
    lifecycle: "test",
    subject: rsviteSubject,
    environment: {
      os: host.os,
      arch: host.arch,
      runnerImage,
      nodeVersion: process.version.slice(1),
      packageManager: { name: packageManager.name, version: pnpmVersion },
      browser: { name: "chromium", version: browserVersion },
    },
    projectRoot: checkout,
    artifactRoot: stagingRoot,
    declared: {
      javascriptApiLevel: "C0",
      capabilityOwners: [{ capability: "html", owner: "rust" }],
      explicitFallbacks: [],
      classifyFailure: (failure) => ({
        kind: "current-compatibility-requirement",
        evidence: `Vite passes after playground/html/vite.config.js runs its transformIndexHtml hook; the rsvite C0 subject ignores configuration and Plugin API, so the unchanged test diverges during ${failure.phase}.`,
      }),
    },
    timeouts: { installMs: 600_000, lifecycleMs: 120_000, browserMs: 60_000 },
  });

  assertExpectedRsviteHtmlPreserveCommentsExecution(report, {
    stdout: await readFile(report.logs.lifecycle.stdout, "utf8"),
    stderr: await readFile(report.logs.lifecycle.stderr, "utf8"),
  });
  publishViteUpstreamBrowserObservation(report, manifest);

  assertPinnedCleanViteCheckout(checkout);
  await rm(rsviteBaselineDir, { recursive: true, force: true });
  // Between preparation and here the run took minutes; protected main may have moved.
  assertPreparedSubjectIsStillCurrent(rsviteSubject);
  await rename(stagingRoot, rsviteBaselineDir);
  process.stdout.write(`${rsviteBaselineResultPath}\n`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
