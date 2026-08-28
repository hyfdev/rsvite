// Run as a subprocess: one fast successful check must leave the active Timeout count unchanged.
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCompatibilityCheck, type RunRequest } from "../src/index.ts";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const address = probe.address();
const port = typeof address === "object" && address !== null ? address.port : 0;
await new Promise<void>((resolve) => probe.close(() => resolve()));

const manifest = {
  contractVersion: 1,
  entries: [
    {
      id: "synthetic-orchestration",
      kind: "real-project",
      source: {
        repository: "https://github.com/vitejs/vite",
        commit: "ee644014aab61e546742b862a7d7b0d6c7d67a7b",
        license: { spdxId: "MIT", path: "LICENSE" },
      },
      lockfile: { path: "pnpm-lock.yaml", packageManager: { name: "pnpm", version: "11.20.0" } },
      commands: {
        install: { argv: [process.execPath, join(fixturesDir, "exit.mjs")] },
        dev: {
          argv: [process.execPath, join(fixturesDir, "serve.mjs")],
          env: { PORT: String(port) },
        },
        build: { argv: [process.execPath, join(fixturesDir, "exit.mjs")] },
        preview: { argv: [process.execPath, join(fixturesDir, "serve.mjs")] },
      },
      readiness: { type: "http-ready", urlPath: "/", expectStatus: 200, timeoutMs: 2_000 },
      browserAcceptance: { entryPath: "/", mainFrameNavigationIsFailure: true },
      expectedCapabilities: ["html"],
      javascriptApiLevel: "C0",
    },
  ],
};

const request: RunRequest = {
  manifest,
  entryId: "synthetic-orchestration",
  lifecycle: "dev",
  subject: { name: "rsvite", version: "0.0.0" },
  environment: {
    os: "linux",
    arch: "x64",
    runnerImage: "local",
    nodeVersion: "24.20.0",
    packageManager: { name: "pnpm", version: "11.20.0" },
  },
  projectRoot: fixturesDir,
  artifactRoot: await mkdtemp(join(tmpdir(), "rsvite-host-exit-")),
  origin: `http://127.0.0.1:${String(port)}`,
  declared: {
    javascriptApiLevel: "C0",
    capabilityOwners: [{ capability: "html", owner: "rust" }],
    explicitFallbacks: [],
    classifyFailure: () => ({ kind: "current-compatibility-requirement", evidence: "probe" }),
  },
  timeouts: { installMs: 2_000, lifecycleMs: 60_000, browserMs: 60_000 },
};

const initialTimeouts = process
  .getActiveResourcesInfo()
  .filter((resource) => resource === "Timeout");
const report = await runCompatibilityCheck(request);

const remainingTimeouts = process
  .getActiveResourcesInfo()
  .filter((resource) => resource === "Timeout");
if (remainingTimeouts.length !== initialTimeouts.length) {
  throw new Error(
    `the run left ${String(remainingTimeouts.length - initialTimeouts.length)} timer(s) active`,
  );
}

console.log(JSON.stringify({ outcome: (report.result as { outcome: string }).outcome }));
