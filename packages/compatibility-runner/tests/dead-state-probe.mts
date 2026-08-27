// Run as a subprocess. `node:fs` is patched before the runner is loaded so that the kernel's
// record of the terminated server reports `X` — Dead — instead of the far more common `Z`.
// Both mean the process has finished; a runner that only recognises `Z` reads the other as a
// process that was still running and credits itself with the stop.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nodeFs = require("node:fs") as {
  readFileSync: (path: string, encoding?: string) => string;
};
const realReadFileSync = nodeFs.readFileSync.bind(nodeFs);

nodeFs.readFileSync = (path: string, encoding?: string) => {
  if (typeof path === "string" && path.startsWith("/proc/") && path.endsWith("/stat")) {
    const pid = path.slice("/proc/".length, -"/stat".length);
    return `${pid} (node) X 1 1 1 0 -1 0 0 0 0 0 0 0 0`;
  }
  return realReadFileSync(path, encoding);
};

const runner = await import("../src/index.ts");
const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const artifactRoot = await mkdtemp(join(tmpdir(), "dead-state-"));
const pidFile = join(artifactRoot, "server.pid");

const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const address = probe.address();
const port = typeof address === "object" && address !== null ? address.port : 0;
await new Promise<void>((resolve) => probe.close(() => resolve()));

const manifest = {
  contractVersion: 1,
  entries: [
    {
      id: "e",
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
          env: { PORT: String(port), OWN_PID_FILE: pidFile, EXIT_ON_SIGTERM: "0" },
        },
        build: { argv: [process.execPath, join(fixturesDir, "exit.mjs")] },
        preview: { argv: [process.execPath, join(fixturesDir, "serve.mjs")] },
      },
      readiness: { type: "http-ready", urlPath: "/", expectStatus: 200, timeoutMs: 5_000 },
      browserAcceptance: { entryPath: "/", mainFrameNavigationIsFailure: true },
      expectedCapabilities: ["html"],
      javascriptApiLevel: "C0",
    },
  ],
};

const report = await runner.runCompatibilityCheck({
  manifest,
  entryId: "e",
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
  artifactRoot,
  origin: `http://127.0.0.1:${String(port)}`,
  declared: {
    javascriptApiLevel: "C0",
    capabilityOwners: [{ capability: "html", owner: "rust" }],
    explicitFallbacks: [],
    classifyFailure: () => ({ kind: "current-compatibility-requirement", evidence: "probe" }),
  },
  browser: {
    open: () => {
      process.kill(Number(realReadFileSync(pidFile, "utf8")), "SIGTERM");
      // Blocking keeps the close event undelivered, leaving only the kernel record to read.
      const until = Date.now() + 250;
      while (Date.now() < until) {
        /* block */
      }
      return Promise.resolve({
        evaluate: () => Promise.resolve(undefined),
        drainEvents: () => [] as never[],
        close: () => Promise.resolve(),
      });
    },
  },
  timeouts: { installMs: 10_000, lifecycleMs: 30_000, browserMs: 10_000 },
});

const result = report.result as {
  outcome: string;
  firstIncompatibleBehavior?: { phase: string; message: string };
};
void EventEmitter;
console.log(JSON.stringify({ outcome: result.outcome, failure: result.firstIncompatibleBehavior }));
