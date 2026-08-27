import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCompatibilityCheck } from "@rsvite/compatibility-runner";
import {
  HTML_PRESERVE_COMMENTS_ENTRY_ID,
  VITE_UPSTREAM_COMMIT,
  htmlPreserveCommentsAdapter,
  readCorpusManifest,
  viteBaselineDir,
} from "../src/index.ts";

const checkout = process.env["VITE_CHECKOUT"];
if (checkout === undefined || checkout.length === 0) {
  throw new Error("VITE_CHECKOUT must be the Vite repository pinned at the corpus commit");
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
if (head !== VITE_UPSTREAM_COMMIT) {
  throw new Error(`VITE_CHECKOUT HEAD is ${head}, expected ${VITE_UPSTREAM_COMMIT}`);
}

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
    os: "linux",
    arch: "x64",
    runnerImage: process.env["RUNNER_IMAGE"] ?? "local",
    nodeVersion: process.version.slice(1),
    packageManager: { name: "pnpm", version: "10.34.5" },
  },
  projectRoot: checkout,
  artifactRoot: viteBaselineDir,
  declared: {
    javascriptApiLevel: "C0",
    capabilityOwners: [{ capability: "html", owner: "vite" }],
    explicitFallbacks: [],
    classifyFailure: (failure) => ({
      kind: "current-compatibility-requirement",
      evidence: `Vite failed ${htmlPreserveCommentsAdapter.testName} during ${failure.phase}`,
    }),
  },
  timeouts: { installMs: 600_000, lifecycleMs: 900_000, browserMs: 60_000 },
});

const result = report.result as { outcome: string };
if (result.outcome !== "pass") {
  throw new Error(`Vite baseline was ${result.outcome}: ${JSON.stringify(report.failure)}`);
}

process.stdout.write(`${report.resultPath}\n`);
