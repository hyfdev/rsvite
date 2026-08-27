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
  assert.match(failure.message, /exited on its own after reporting readiness/);
});
