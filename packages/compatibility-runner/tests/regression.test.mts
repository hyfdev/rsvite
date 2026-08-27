import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
