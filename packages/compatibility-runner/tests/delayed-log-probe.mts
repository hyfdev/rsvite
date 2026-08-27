// Run as a subprocess. `node:fs` is patched before the runner is imported so that every log
// stream finishes 250 ms after it is asked to, which is what a slow or contended filesystem
// does. A runner that assembles evidence from whatever exists at that moment returns a result
// naming nothing, and the log appears afterwards holding the error the result failed to name.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "fail" ? "fail" : "delay";
const require = createRequire(import.meta.url);
const nodeFs = require("node:fs") as {
  createWriteStream: (path: string) => unknown;
  writeFileSync: (path: string, data: string) => void;
  existsSync: (path: string) => boolean;
};
const realWriteFileSync = nodeFs.writeFileSync.bind(nodeFs);

// The file itself appears 250 ms after the stream is ended, which is what a slow or contended
// filesystem does. A runner that reads the directory before its own streams have closed sees
// nothing there and returns a result that names no evidence at all.
nodeFs.createWriteStream = (path: string) => {
  const emitter = new EventEmitter() as EventEmitter & {
    write: (chunk: Buffer | string) => boolean;
    end: () => void;
  };
  let buffered = "";
  emitter.write = (chunk: Buffer | string) => {
    if (mode === "fail") {
      if (!failed) {
        failed = true;
        setTimeout(() => emitter.emit("error", new Error("the log device is gone")), 0);
      }
      return false;
    }
    buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    return true;
  };
  // A permanent listener so EventEmitter never treats an error as unhandled; the runner
  // attaches its own and is the one that acts on it.
  emitter.on("error", () => undefined);
  let ended = false;
  let failed = false;
  emitter.end = () => {
    if (ended) return;
    ended = true;
    setTimeout(() => {
      if (mode === "fail") {
        emitter.emit("error", new Error("the log device is gone"));
        return;
      }
      realWriteFileSync(path, buffered);
      emitter.emit("close");
    }, 250);
  };
  return emitter;
};

const runner = await import("../src/index.ts");
const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const artifactRoot = await mkdtemp(join(tmpdir(), "delayed-log-"));

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
        install: { argv: ["definitely-not-a-real-executable-xyz"] },
        dev: { argv: [process.execPath, join(fixturesDir, "serve.mjs")] },
        build: { argv: [process.execPath, join(fixturesDir, "exit.mjs")] },
        preview: { argv: [process.execPath, join(fixturesDir, "serve.mjs")] },
      },
      readiness: { type: "process-exit", timeoutMs: 5_000 },
      browserAcceptance: { entryPath: "/", mainFrameNavigationIsFailure: true },
      expectedCapabilities: ["html"],
      javascriptApiLevel: "C0",
    },
  ],
};

const run = runner.runCompatibilityCheck({
  manifest,
  entryId: "e",
  lifecycle: "build",
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
  declared: {
    javascriptApiLevel: "C0",
    capabilityOwners: [{ capability: "html", owner: "rust" }],
    explicitFallbacks: [],
    classifyFailure: () => ({ kind: "current-compatibility-requirement", evidence: "probe" }),
  },
  timeouts: { installMs: 10_000, lifecycleMs: 10_000, browserMs: 5_000 },
});

if (mode === "fail") {
  // A log the runner could not write leaves the run with nothing to point at, so it must fail
  // rather than return a result with a gap where its evidence should be.
  try {
    await run;
    const r = (await run).result as Record<string, unknown>;
    console.log(
      JSON.stringify({
        rejected: false,
        mode,
        outcome: r["outcome"],
        first: r["firstIncompatibleBehavior"],
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        rejected: true,
        message: String(error),
        wroteResult: nodeFs.existsSync(join(artifactRoot, "result.json")),
      }),
    );
  }
} else {
  const report = await run;
  const result = report.result as {
    artifactPaths: string[];
    firstIncompatibleBehavior?: { evidencePath?: string };
  };
  console.log(
    JSON.stringify({
      artifactPaths: result.artifactPaths,
      evidencePath: result.firstIncompatibleBehavior?.evidencePath,
    }),
  );
}
