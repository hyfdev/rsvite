import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vite-plus/test";
import {
  createSyntheticBrowser,
  runCommand,
  runCompatibilityCheck,
  startCommand,
} from "../src/index.ts";
import { baseRequest, fixturesDir, freePort, syntheticManifest, withPort } from "./support.mts";

function fixture(name: string): string {
  return join(fixturesDir, name);
}

/** An entry that declares the capability these probes claim, so the pair stays coherent. */
function claimingHmr(manifest: unknown): unknown {
  const document = structuredClone(manifest) as {
    entries: { expectedCapabilities: string[] }[];
  };
  document.entries[0]!.expectedCapabilities = ["html", "hmr-without-full-reload"];
  return document;
}

/** Runs a probe in its own process, because it patches `node:fs` before loading the runner. */
async function runProbe(
  name: string,
  args: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const probe = fileURLToPath(new URL(`./${name}`, import.meta.url));
  const finished = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", probe, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
  assert.equal(finished.code, 0, `the probe did not finish cleanly: ${finished.stderr}`);
  return JSON.parse(finished.stdout.trim()) as Record<string, unknown>;
}

async function isAlive(pid: number): Promise<boolean> {
  await delay(50);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("an invalid manifest is rejected before any command can run", async () => {
  const request = await baseRequest("rsvite");
  const markerFile = join(request.artifactRoot, "marker");
  const manifest = structuredClone(syntheticManifest()) as {
    entries: {
      source: { commit: string };
      commands: Record<string, { argv: string[]; env?: Record<string, string> }>;
    }[];
  };
  // A moving reference instead of a pinned commit: the canonical validator rejects it.
  manifest.entries[0]!.source.commit = "main";
  manifest.entries[0]!.commands["install"] = {
    argv: [process.execPath, fixture("marker.mjs")],
    env: { MARKER_FILE: markerFile },
  };

  await assert.rejects(runCompatibilityCheck({ ...request, manifest }), /manifest is not valid/);
  assert.equal(existsSync(markerFile), false, "install ran despite the manifest being invalid");
});

test("stopping a command removes a descendant that ignores SIGTERM", async () => {
  const request = await baseRequest("rsvite");
  const pidFile = join(request.artifactRoot, "stubborn.pid");

  const started = startCommand({
    argv: [process.execPath, fixture("stubborn.mjs")],
    env: { CHILD_PID_FILE: pidFile },
  });
  while (!existsSync(pidFile)) await delay(25);
  const descendant = Number(readFileSync(pidFile, "utf8"));
  assert.equal(await isAlive(descendant), true, "the descendant should be running before the stop");

  await started.stop();

  assert.equal(await isAlive(descendant), false, "stop() returned while the descendant was alive");
});

test("a command whose leader exits first still waits for its descendant", async () => {
  const request = await baseRequest("rsvite");
  const pidFile = join(request.artifactRoot, "leader.pid");

  const outcome = await runCommand(
    { argv: [process.execPath, fixture("leader-exits.mjs")], env: { CHILD_PID_FILE: pidFile } },
    10_000,
  );

  assert.equal(outcome.exitCode, 0);
  const descendant = Number(readFileSync(pidFile, "utf8"));
  assert.equal(
    await isAlive(descendant),
    false,
    "runCommand returned while the descendant was alive",
  );
});

test("a server that accepts but never answers cannot outlast the readiness deadline", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", { origin: `http://127.0.0.1:${String(port)}` });
  const manifest = structuredClone(syntheticManifest()) as {
    entries: {
      readiness: Record<string, unknown>;
      commands: Record<string, { argv: string[]; env?: Record<string, string> }>;
    }[];
  };
  manifest.entries[0]!.commands["dev"] = {
    argv: [process.execPath, fixture("hang-server.mjs")],
    env: { PORT: String(port) },
  };
  manifest.entries[0]!.readiness = { type: "http-ready", urlPath: "/", timeoutMs: 500 };

  const startedAt = Date.now();
  const report = await runCompatibilityCheck({ ...request, manifest });
  const elapsed = Date.now() - startedAt;
  const failure = (report.result as Record<string, unknown>)["firstIncompatibleBehavior"] as {
    message: string;
  };

  assert.match(failure.message, /readiness was not reached/);
  assert.ok(elapsed < 5_000, `the readiness deadline did not take effect (${String(elapsed)}ms)`);
});

test("an adapter that hangs is abandoned at the browser deadline", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: createSyntheticBrowser({ hangUntilAborted: "open" }),
    timeouts: { installMs: 10_000, lifecycleMs: 10_000, browserMs: 300 },
  });

  const startedAt = Date.now();
  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const elapsed = Date.now() - startedAt;
  const failure = (report.result as Record<string, unknown>)["firstIncompatibleBehavior"] as {
    phase: string;
    message: string;
  };

  assert.equal(failure.phase, "browser");
  assert.match(failure.message, /opening the page/);
  assert.ok(elapsed < 5_000, `the browser deadline did not take effect (${String(elapsed)}ms)`);
});

test("the lifecycle budget bounds the whole phase, not just readiness", async () => {
  const request = await baseRequest("rsvite", {
    lifecycle: "build",
    timeouts: { installMs: 10_000, lifecycleMs: 300, browserMs: 5_000 },
  });
  const manifest = structuredClone(syntheticManifest()) as {
    entries: {
      readiness: Record<string, unknown>;
      commands: Record<string, { env?: Record<string, string> }>;
    }[];
  };
  manifest.entries[0]!.readiness = { type: "process-exit", timeoutMs: 30_000 };
  manifest.entries[0]!.commands["build"]!.env = { DELAY_MS: "5000" };

  const startedAt = Date.now();
  const report = await runCompatibilityCheck({ ...request, manifest });
  const elapsed = Date.now() - startedAt;
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { phase: string; message: string };

  assert.equal(
    result["outcome"],
    "fail",
    "a phase that ran past its budget was recorded as a pass",
  );
  assert.equal(failure.phase, "build");
  assert.match(failure.message, /did not finish within 300ms/);
  assert.ok(elapsed < 4_000, `the lifecycle deadline did not take effect (${String(elapsed)}ms)`);
});

test("evidence paths are relative to the written result and name only files that exist", async () => {
  const request = await baseRequest("rsvite");
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { env?: Record<string, string> }> }[];
  };
  manifest.entries[0]!.commands["install"]!.env = { EXIT_CODE: "3" };

  const report = await runCompatibilityCheck({ ...request, manifest });
  const result = report.result as Record<string, unknown>;
  const artifactPaths = result["artifactPaths"] as string[];
  const failure = result["firstIncompatibleBehavior"] as { evidencePath: string };

  assert.ok(
    existsSync(report.resultPath),
    "the result was not written where its paths resolve from",
  );
  assert.deepEqual(artifactPaths, ["install.stdout.log", "install.stderr.log"]);
  for (const path of artifactPaths) {
    assert.equal(isAbsolute(path), false, `${path} is absolute`);
    assert.ok(existsSync(join(request.artifactRoot, path)), `${path} does not exist`);
  }
  assert.equal(failure.evidencePath, "install.stderr.log");
  assert.ok(existsSync(join(request.artifactRoot, failure.evidencePath)));
});

test("a successful run writes a result whose evidence resolves from its own directory", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", { origin: `http://127.0.0.1:${String(port)}` });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const artifactPaths = (report.result as Record<string, unknown>)["artifactPaths"] as string[];

  assert.deepEqual(JSON.parse(readFileSync(report.resultPath, "utf8")), report.result);
  assert.ok(artifactPaths.length > 0);
  for (const path of artifactPaths) {
    assert.equal(isAbsolute(path), false, `${path} is absolute`);
    assert.ok(existsSync(join(request.artifactRoot, path)), `${path} does not exist`);
  }
});

test("the lifecycle deadline aborts an update that is still running", async () => {
  const port = await freePort();
  let updateSettled = false;
  let updateAborted = false;
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: createSyntheticBrowser({
      documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
    }),
    // Honours the contract: settles only once the runner aborts it.
    update: (_page, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            updateAborted = true;
            updateSettled = true;
            resolve();
          },
          { once: true },
        );
      }),
    timeouts: { installMs: 10_000, lifecycleMs: 400, browserMs: 30_000 },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const result = report.result as Record<string, unknown>;

  assert.equal(
    result["outcome"],
    "fail",
    "a run whose update never finished was recorded as a pass",
  );
  assert.equal(updateAborted, true, "the lifecycle deadline did not reach the update");
  assert.equal(updateSettled, true, "the result was written while the update was still running");
});

test("browser steps share one budget instead of each getting the whole one", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: createSyntheticBrowser({
      documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
      stepDelayMs: 180,
    }),
    update: () => Promise.resolve(),
    timeouts: { installMs: 10_000, lifecycleMs: 30_000, browserMs: 250 },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const failure = (report.result as Record<string, unknown>)["firstIncompatibleBehavior"] as {
    phase: string;
  };

  // open plus two sentinel reads already exceed 250ms together, though none exceeds it alone.
  assert.equal((report.result as Record<string, unknown>)["outcome"], "fail");
  assert.equal(failure.phase, "browser");
});

test("an adapter that ignores its abort signal fails the run without writing a result", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: createSyntheticBrowser({ ignoresAbort: "open" }),
    timeouts: { installMs: 10_000, lifecycleMs: 30_000, browserMs: 200 },
  });

  await assert.rejects(
    runCompatibilityCheck({ ...request, manifest: withPort(request.manifest, port) }),
    /abort-settle contract/,
  );
  assert.equal(
    existsSync(join(request.artifactRoot, "result.json")),
    false,
    "a result was written while the adapter was still running",
  );
});

test("a run claiming HMR without a browser is a failure, not a pass", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", { origin: `http://127.0.0.1:${String(port)}` });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(claimingHmr(request.manifest), port),
    declared: {
      ...request.declared,
      capabilityOwners: [{ capability: "hmr-without-full-reload", owner: "rust" }],
    },
  });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { message: string };

  assert.equal(result["outcome"], "fail", "an HMR claim passed without a browser ever opening");
  assert.match(failure.message, /no browser was given/);
});

test("a run claiming HMR whose page never set a sentinel is a failure", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    // No document memory: the sentinel reads as undefined before and after, which used to look
    // exactly like a sentinel that survived.
    browser: createSyntheticBrowser(),
    update: () => Promise.resolve(),
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(claimingHmr(request.manifest), port),
    declared: {
      ...request.declared,
      capabilityOwners: [{ capability: "hmr-without-full-reload", owner: "rust" }],
    },
  });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { message: string };

  assert.equal(result["outcome"], "fail", "an uninitialized sentinel counted as preserved");
  assert.match(failure.message, /no in-memory sentinel before the update/);
});

test("a completed run leaves no timer holding the host open", async () => {
  const probe = fileURLToPath(new URL("./host-exit-probe.mts", import.meta.url));
  const startedAt = Date.now();

  const finished = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", probe], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.once("close", (code) => resolve({ code, stdout }));
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(finished.code, 0, "the probe did not finish cleanly");
  assert.match(finished.stdout, /pass/);
  // Budgets in the probe are 2,000 ms. A leftover timer would hold this host until one fires.
  assert.ok(
    elapsed < 1_800,
    `the host stayed alive after its work finished (${String(elapsed)}ms)`,
  );
});

test("a lifecycle process that dies after readiness cannot be recorded as a pass", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: createSyntheticBrowser({ stepDelayMs: 150 }),
    timeouts: { installMs: 10_000, lifecycleMs: 10_000, browserMs: 5_000 },
  });
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { argv: string[]; env?: Record<string, string> }> }[];
  };
  // HTTP readiness, then the server exits by itself while the browser is still working.
  manifest.entries[0]!.commands["dev"] = {
    argv: [process.execPath, fixture("flaky-server.mjs")],
    env: { PORT: String(port), EXIT_AFTER_MS: "100", EXIT_CODE: "7" },
  };

  const report = await runCompatibilityCheck({ ...request, manifest });
  const result = report.result as Record<string, unknown>;

  assert.equal(result["outcome"], "fail", "a process that exited with 7 was recorded as a pass");
  assert.equal((result["command"] as { exitCode: number }).exitCode, 7);
});

test("a command that cannot spawn is a failure, not a dead host", async () => {
  const probe = fileURLToPath(new URL("./spawn-failure-probe.mts", import.meta.url));

  const finished = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", probe], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    },
  );

  assert.equal(finished.code, 0, `the host died on a failed spawn: ${finished.stderr}`);
  const observed = JSON.parse(finished.stdout.trim()) as {
    exitCode: number | null;
    sawEnoent: boolean;
  };
  assert.equal(observed.sawEnoent, true, "the spawn error was not recorded on the command output");
});

test("a page produced just after the deadline is still closed", async () => {
  const port = await freePort();
  const browser = createSyntheticBrowser({ resolveOnAbort: true });
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser,
    timeouts: { installMs: 10_000, lifecycleMs: 30_000, browserMs: 200 },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });

  assert.equal((report.result as Record<string, unknown>)["outcome"], "fail");
  assert.ok(
    (browser.lastPage()?.closeCalls() ?? 0) > 0,
    "the page the adapter produced after the abort was never closed",
  );
});

test("a page that refuses to close fails the run instead of passing it", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: createSyntheticBrowser({ closeFails: "page remained open" }),
  });

  await assert.rejects(
    runCompatibilityCheck({ ...request, manifest: withPort(request.manifest, port) }),
    /closing the page/,
  );
  assert.equal(
    existsSync(join(request.artifactRoot, "result.json")),
    false,
    "a result was written for a run whose page never closed",
  );
});

test("the recorded command cwd is the directory the command actually ran in", async () => {
  const request = await baseRequest("rsvite");
  const manifest = structuredClone(syntheticManifest()) as {
    entries: {
      commands: Record<string, { argv: string[]; cwd?: string; env?: Record<string, string> }>;
    }[];
  };
  manifest.entries[0]!.commands["install"]!.cwd = ".";
  manifest.entries[0]!.commands["install"]!.env = { EXIT_CODE: "3" };

  const report = await runCompatibilityCheck({ ...request, manifest });
  const command = (report.result as Record<string, unknown>)["command"] as { cwd: string };

  assert.equal(command.cwd, join(request.projectRoot, "."));
});

test("a reused artifact directory cannot donate evidence to this run", async () => {
  const request = await baseRequest("rsvite");
  await mkdir(request.artifactRoot, { recursive: true });
  // Logs left by an earlier run of a different lifecycle command.
  await writeFile(join(request.artifactRoot, "dev.stdout.log"), "stale", "utf8");
  await writeFile(join(request.artifactRoot, "dev.stderr.log"), "stale", "utf8");

  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { env?: Record<string, string> }> }[];
  };
  manifest.entries[0]!.commands["install"]!.env = { EXIT_CODE: "3" };

  const report = await runCompatibilityCheck({ ...request, manifest });
  const artifactPaths = (report.result as Record<string, unknown>)["artifactPaths"] as string[];

  assert.deepEqual(artifactPaths, ["install.stdout.log", "install.stderr.log"]);
});

test("the first incompatible behavior is the first one observed", async () => {
  const port = await freePort();
  const browser = createSyntheticBrowser({
    documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
    openEvents: [{ type: "console-error", message: "first failure" }],
  });
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser,
    update: () => {
      browser.lastPage()?.navigate(`http://127.0.0.1:${String(port)}/`);
      return Promise.resolve();
    },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const failure = (report.result as Record<string, unknown>)["firstIncompatibleBehavior"] as {
    message: string;
  };

  // The console error happened on load; the navigation came later during the update.
  assert.match(failure.message, /console-error: first failure/);
});

test("a lifecycle process that exits cleanly after readiness is still a failure", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: createSyntheticBrowser({ stepDelayMs: 150 }),
    timeouts: { installMs: 10_000, lifecycleMs: 10_000, browserMs: 5_000 },
  });
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { argv: string[]; env?: Record<string, string> }> }[];
  };
  // Exit code 0 this time: under HTTP readiness the server was supposed to keep serving, so
  // ending at all means acceptance was measured against something that was no longer there.
  manifest.entries[0]!.commands["dev"] = {
    argv: [process.execPath, fixture("flaky-server.mjs")],
    env: { PORT: String(port), EXIT_AFTER_MS: "100", EXIT_CODE: "0" },
  };

  const report = await runCompatibilityCheck({ ...request, manifest });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { message: string };

  assert.equal(
    result["outcome"],
    "fail",
    "a server that vanished mid-acceptance was recorded as usable",
  );
  assert.match(failure.message, /ended on its own/);
});

test("a process killed during acceptance is not mistaken for one the runner stopped", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", { origin: `http://127.0.0.1:${String(port)}` });
  const pidFile = join(request.artifactRoot, "server.pid");
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { argv: string[]; env?: Record<string, string> }> }[];
  };
  manifest.entries[0]!.commands["dev"] = {
    argv: [process.execPath, fixture("serve.mjs")],
    env: { PORT: String(port), OWN_PID_FILE: pidFile },
  };

  const report = await runCompatibilityCheck({
    ...request,
    manifest,
    // The browser phase only starts after readiness, so killing from `open` puts the death
    // squarely inside acceptance. Its `close` event then arrives while the runner is already
    // stopping, which is what used to make it look cooperative.
    browser: {
      open: async () => {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          evaluate: () => Promise.resolve(undefined),
          drainEvents: () => [],
          close: () => Promise.resolve(),
        };
      },
    },
  });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { message: string };

  assert.equal(result["outcome"], "fail", "a process killed mid-acceptance was recorded as a pass");
  assert.match(failure.message, /ended on its own during browser acceptance/);
});

test("an early exit outranks a later browser failure", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: createSyntheticBrowser({ hangUntilAborted: "open" }),
    timeouts: { installMs: 10_000, lifecycleMs: 30_000, browserMs: 2_000 },
  });
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { argv: string[]; env?: Record<string, string> }> }[];
  };
  manifest.entries[0]!.commands["dev"] = {
    argv: [process.execPath, fixture("flaky-server.mjs")],
    env: { PORT: String(port), EXIT_AFTER_MS: "100", EXIT_CODE: "7" },
  };

  const report = await runCompatibilityCheck({ ...request, manifest });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { message: string };

  // The exit happened at 100 ms; the browser budget would not have expired until 2,000 ms.
  assert.match(failure.message, /ended on its own/);
});

test("an error reported during the final sentinel read is not lost", async () => {
  const port = await freePort();
  const browser = createSyntheticBrowser({
    documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
  });
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser,
    update: () => {
      // Emitted so that it is queued when the final sentinel read drains events.
      browser
        .lastPage()
        ?.emit({ type: "console-error", message: "error during final sentinel read" });
      return Promise.resolve();
    },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const result = report.result as Record<string, unknown>;

  assert.equal(result["outcome"], "fail", "an error emitted in the update window was dropped");
  assert.deepEqual(result["browserErrors"], [
    { type: "console-error", message: "error during final sentinel read" },
  ]);
});

test("inside the update window the earlier event decides the first failure", async () => {
  const port = await freePort();
  const browser = createSyntheticBrowser({
    documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
  });
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser,
    update: () => {
      const page = browser.lastPage();
      page?.emit({ type: "console-error", message: "error before the reload" });
      page?.navigate(`http://127.0.0.1:${String(port)}/`);
      return Promise.resolve();
    },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const failure = (report.result as Record<string, unknown>)["firstIncompatibleBehavior"] as {
    message: string;
  };

  assert.match(failure.message, /console-error: error before the reload/);
});

test("a failed spawn records the real error in the evidence the result names", async () => {
  const request = await baseRequest("rsvite");
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { argv: string[] }> }[];
  };
  manifest.entries[0]!.commands["install"] = { argv: ["definitely-not-a-real-executable-xyz"] };

  const report = await runCompatibilityCheck({ ...request, manifest });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { message: string; evidencePath: string };

  assert.equal(result["outcome"], "fail");
  assert.match(failure.message, /ENOENT|could not start/);
  const evidence = readFileSync(join(request.artifactRoot, failure.evidencePath), "utf8");
  assert.match(
    evidence,
    /ENOENT/,
    "the evidence file the result names does not contain the failure",
  );
});

test("work that overran its budget while blocking the loop is not a pass", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: {
      open: () => {
        // Synchronous work cannot be preempted, so the timer callback never runs in time.
        const until = Date.now() + 400;
        while (Date.now() < until) {
          /* block */
        }
        return Promise.resolve({
          evaluate: () => Promise.resolve(undefined),
          drainEvents: () => [],
          close: () => Promise.resolve(),
        });
      },
    },
    timeouts: { installMs: 10_000, lifecycleMs: 30_000, browserMs: 100 },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { phase: string; message: string };

  assert.equal(
    result["outcome"],
    "fail",
    "work that finished after its budget was recorded as a pass",
  );
  assert.equal(failure.phase, "browser");
  assert.match(failure.message, /opening the page did not finish within its deadline/);
});

test("an adapter that throws synchronously becomes a classified browser failure", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: {
      open: () => {
        throw new Error("synchronous adapter failure");
      },
    },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const failure = (report.result as Record<string, unknown>)["firstIncompatibleBehavior"] as {
    phase: string;
    message: string;
  };

  assert.equal(failure.phase, "browser");
  assert.match(failure.message, /synchronous adapter failure/);
});

test("an update that reports an error and then rejects keeps the error", async () => {
  const port = await freePort();
  const browser = createSyntheticBrowser({
    documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
  });
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser,
    update: () => {
      browser.lastPage()?.emit({ type: "console-error", message: "reported before the rejection" });
      return Promise.reject(new Error("the update gave up"));
    },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { phase: string; message: string };

  assert.equal(failure.phase, "browser");
  assert.match(failure.message, /console-error: reported before the rejection/);
  assert.deepEqual(result["browserErrors"], [
    { type: "console-error", message: "reported before the rejection" },
  ]);
});

test("an error reported before a failing sentinel read outranks the read's own failure", async () => {
  const port = await freePort();
  const browser = createSyntheticBrowser({
    documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
  });
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser,
    update: () => {
      const page = browser.lastPage();
      page?.emit({ type: "page-error", message: "thrown before the final read" });
      // The page is closed from under the final read, so that read rejects afterwards.
      void page?.close(AbortSignal.timeout(1_000));
      return Promise.resolve();
    },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { phase: string; message: string };

  assert.equal(failure.phase, "browser");
  assert.match(failure.message, /page-error: thrown before the final read/);
  assert.deepEqual(result["browserErrors"], [
    { type: "page-error", message: "thrown before the final read" },
  ]);
});

test("a browser failure names no log evidence, because it has none", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: createSyntheticBrowser({
      openEvents: [{ type: "console-error", message: "browser said no" }],
    }),
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as Record<string, unknown>;

  assert.equal(failure["phase"], "browser");
  assert.equal(
    "evidencePath" in failure,
    false,
    "a browser failure pointed at an unrelated command log",
  );
  assert.deepEqual(result["browserErrors"], [
    { type: "console-error", message: "browser said no" },
  ]);
});

test("a navigation reported before a failing operation still decides the failure", async () => {
  const port = await freePort();
  const browser = createSyntheticBrowser({
    documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
  });
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser,
    update: () => {
      browser.lastPage()?.navigate(`http://127.0.0.1:${String(port)}/`);
      return Promise.reject(new Error("the update gave up after navigating"));
    },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const failure = (report.result as Record<string, unknown>)["firstIncompatibleBehavior"] as {
    message: string;
  };

  // The navigation was observed first; the rejection only happened afterwards.
  assert.match(failure.message, /full reload: the main frame navigated/);
});

test("an ordinary update rejection is not overwritten by a later lifecycle exit", async () => {
  const port = await freePort();
  const browser = createSyntheticBrowser({
    documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
  });
  const request = await baseRequest("rsvite", { origin: `http://127.0.0.1:${String(port)}` });
  const pidFile = join(request.artifactRoot, "server.pid");
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { argv: string[]; env?: Record<string, string> }> }[];
  };
  manifest.entries[0]!.commands["dev"] = {
    argv: [process.execPath, fixture("serve.mjs")],
    env: { PORT: String(port), OWN_PID_FILE: pidFile },
  };

  const report = await runCompatibilityCheck({
    ...request,
    manifest,
    browser,
    update: () => {
      // The update fails on its own merits, and only then does the server die.
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      return Promise.reject(new Error("the update failed on its own"));
    },
  });
  const failure = (report.result as Record<string, unknown>)["firstIncompatibleBehavior"] as {
    phase: string;
    message: string;
  };

  assert.equal(failure.phase, "browser");
  assert.match(failure.message, /the update failed on its own/);
});

test("an error produced after a timeout does not displace the timeout", async () => {
  const port = await freePort();
  const browser = createSyntheticBrowser({
    documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
  });
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser,
    update: (_page, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            // Reported only once the runner had already given up on this update.
            browser.lastPage()?.emit({ type: "console-error", message: "after the timeout" });
            resolve();
          },
          { once: true },
        );
      }),
    timeouts: { installMs: 10_000, lifecycleMs: 30_000, browserMs: 300 },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const failure = (report.result as Record<string, unknown>)["firstIncompatibleBehavior"] as {
    message: string;
  };

  assert.match(failure.message, /the update did not finish within its deadline/);
});

test("a lifecycle command that does not exist says so", async () => {
  const request = await baseRequest("rsvite");
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { argv: string[]; env?: Record<string, string> }> }[];
  };
  manifest.entries[0]!.commands["dev"] = { argv: ["definitely-not-a-real-executable-xyz"] };

  const report = await runCompatibilityCheck({ ...request, manifest });
  const failure = (report.result as Record<string, unknown>)["firstIncompatibleBehavior"] as {
    phase: string;
    message: string;
  };

  assert.equal(failure.phase, "dev");
  assert.match(failure.message, /could not start.*ENOENT/);
});

test("a server that turns an external SIGTERM into a clean exit still fails the run", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", { origin: `http://127.0.0.1:${String(port)}` });
  const pidFile = join(request.artifactRoot, "server.pid");
  const marker = join(request.artifactRoot, "terminated");
  let serverPid = 0;
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { argv: string[]; env?: Record<string, string> }> }[];
  };
  // The server handles SIGTERM itself and exits with code 0, so its outcome carries no signal:
  // the signal name alone cannot tell this apart from a stop the runner requested.
  manifest.entries[0]!.commands["dev"] = {
    argv: [process.execPath, fixture("serve.mjs")],
    env: {
      PORT: String(port),
      OWN_PID_FILE: pidFile,
      EXIT_ON_SIGTERM: "0",
      EXIT_MARKER: marker,
    },
  };

  const report = await runCompatibilityCheck({
    ...request,
    manifest,
    browser: {
      open: async () => {
        serverPid = Number(readFileSync(pidFile, "utf8"));
        process.kill(serverPid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          evaluate: () => Promise.resolve(undefined),
          drainEvents: () => [],
          close: () => Promise.resolve(),
        };
      },
    },
  });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { phase: string; message: string };

  // The regression is only meaningful if the signal really landed and the server really left.
  assert.equal(readFileSync(marker, "utf8"), "terminated", "the server never handled the signal");
  assert.equal(await isAlive(serverPid), false, "the server was still running");
  assert.equal(result["outcome"], "fail", "an externally terminated server was recorded as a pass");
  assert.equal(failure.phase, "dev");
  assert.match(failure.message, /ended on its own during browser acceptance/);
});

test("an external termination is not hidden by a host that was too busy to notice", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", { origin: `http://127.0.0.1:${String(port)}` });
  const pidFile = join(request.artifactRoot, "server.pid");
  const marker = join(request.artifactRoot, "terminated");
  let serverPid = 0;
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { argv: string[]; env?: Record<string, string> }> }[];
  };
  manifest.entries[0]!.commands["dev"] = {
    argv: [process.execPath, fixture("serve.mjs")],
    env: {
      PORT: String(port),
      OWN_PID_FILE: pidFile,
      EXIT_ON_SIGTERM: "0",
      EXIT_MARKER: marker,
    },
  };

  const report = await runCompatibilityCheck({
    ...request,
    manifest,
    browser: {
      open: () => {
        serverPid = Number(readFileSync(pidFile, "utf8"));
        process.kill(serverPid, "SIGTERM");
        // Blocking the loop keeps the close event undelivered until after the stop begins, and
        // leaves the exited process a zombie — which still accepts signals. Neither the event
        // nor a successful signal can tell the runner what happened; the kernel's record can.
        const until = Date.now() + 250;
        while (Date.now() < until) {
          /* block */
        }
        return Promise.resolve({
          evaluate: () => Promise.resolve(undefined),
          drainEvents: () => [],
          close: () => Promise.resolve(),
        });
      },
    },
  });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { phase: string; message: string };

  // The regression is only meaningful if the signal really landed and the server really left.
  assert.equal(readFileSync(marker, "utf8"), "terminated", "the server never handled the signal");
  assert.equal(await isAlive(serverPid), false, "the server was still running");
  assert.equal(result["outcome"], "fail", "an externally terminated server was recorded as a pass");
  assert.equal(failure.phase, "dev");
  assert.match(failure.message, /ended on its own/);
});

test("a result never names evidence a slow filesystem has not written yet", async () => {
  // The probe runs in a subprocess because it replaces `node:fs` before the runner is loaded,
  // so that every log file appears 250 ms after its stream is ended. A runner that reads the
  // directory before its own streams have closed returns a result naming nothing at all.
  const observed = await runProbe("delayed-log-probe.mts");

  assert.deepEqual(observed["artifactPaths"], ["install.stdout.log", "install.stderr.log"]);
  assert.equal(observed["evidencePath"], "install.stderr.log");
});

test("a process the kernel reports as dead rather than zombie is still not our doing", async () => {
  // `Z` is the common record for a finished process, but `X` and `x` mean Dead just as surely.
  // Reading only the first lets the others be misread as a process that was still running.
  const observed = await runProbe("dead-state-probe.mts");
  const failure = observed["failure"] as { phase: string; message: string };

  assert.equal(observed["outcome"], "fail", "a dead process was credited to the runner's stop");
  assert.equal(failure.phase, "dev");
  assert.match(failure.message, /ended on its own/);
});

test("a log the runner cannot write fails the run instead of thinning the evidence", async () => {
  const observed = await runProbe("delayed-log-probe.mts", ["fail"]);

  assert.equal(observed["rejected"], true, "a result was returned for a run with no usable log");
  assert.match(String(observed["message"]), /could not write .*install\.stderr\.log/);
  assert.equal(observed["wroteResult"], false, "a result was written despite the failed log");
});
