import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vite-plus/test";
import { createContractValidators } from "@rsvite/compatibility-contract";
import { createSyntheticBrowser, runCompatibilityCheck } from "../src/index.ts";
import { baseRequest, declaredFor, freePort, syntheticManifest, withPort } from "./support.mts";

const validators = createContractValidators();

function resultOf(report: { result: unknown }): Record<string, unknown> {
  return report.result as Record<string, unknown>;
}

test("a successful run emits a result the contract accepts with its manifest", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", { origin: `http://127.0.0.1:${String(port)}` });
  const manifest = withPort(request.manifest, port);

  const report = await runCompatibilityCheck({ ...request, manifest });

  assert.equal(resultOf(report).outcome, "pass");
  assert.equal(report.failure, undefined);
  const check = validators.validateResultAgainstManifest(manifest, report.result);
  assert.deepEqual(check.valid ? [] : check.violations, []);
  assert.ok(existsSync(report.logs.lifecycle.stdout), "the raw lifecycle output is preserved");
});

test("vite and rsvite reach the result through the same orchestration", async () => {
  const outcomes: Record<string, unknown>[] = [];
  for (const subject of ["vite", "rsvite"] as const) {
    const port = await freePort();
    const request = await baseRequest(subject, { origin: `http://127.0.0.1:${String(port)}` });
    const report = await runCompatibilityCheck({
      ...request,
      manifest: withPort(request.manifest, port),
    });
    outcomes.push(resultOf(report));
  }

  const [vite, rsvite] = outcomes as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(vite["outcome"], "pass");
  assert.equal(rsvite["outcome"], "pass");
  // Only the declared inputs differ; the command, environment and phase record are identical.
  assert.deepEqual(vite["command"], rsvite["command"]);
  assert.deepEqual(vite["capabilityOwners"], [{ capability: "html", owner: "vite" }]);
  assert.deepEqual(rsvite["capabilityOwners"], [{ capability: "html", owner: "rust" }]);
});

test("a failing install is recorded as an install failure and never reaches the lifecycle", async () => {
  const request = await baseRequest("rsvite");
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { env?: Record<string, string> }> }[];
  };
  manifest.entries[0]!.commands["install"]!.env = { EXIT_CODE: "3" };

  const report = await runCompatibilityCheck({ ...request, manifest });
  const result = resultOf(report);

  assert.equal(result["outcome"], "fail");
  assert.equal((result["firstIncompatibleBehavior"] as { phase: string }).phase, "install");
  assert.ok(
    !existsSync(join(request.artifactRoot, "dev.stdout.log")),
    "the lifecycle never started",
  );
});

test("an install that outlives its timeout is reported as a timeout, not a crash", async () => {
  const request = await baseRequest("rsvite", {
    timeouts: { installMs: 300, lifecycleMs: 10_000, browserMs: 5_000 },
  });
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { env?: Record<string, string> }> }[];
  };
  manifest.entries[0]!.commands["install"]!.env = { DELAY_MS: "10000" };

  const report = await runCompatibilityCheck({ ...request, manifest });
  const failure = resultOf(report)["firstIncompatibleBehavior"] as {
    phase: string;
    message: string;
  };

  assert.equal(failure.phase, "install");
  assert.match(failure.message, /did not finish within its timeout/);
});

test("a lifecycle command that outlives its timeout is reported as a timeout", async () => {
  const request = await baseRequest("rsvite", { lifecycle: "build" });
  const manifest = structuredClone(syntheticManifest()) as {
    entries: {
      readiness: Record<string, unknown>;
      commands: Record<string, { env?: Record<string, string> }>;
    }[];
  };
  manifest.entries[0]!.readiness = { type: "process-exit", timeoutMs: 300 };
  manifest.entries[0]!.commands["build"]!.env = { DELAY_MS: "10000" };

  const report = await runCompatibilityCheck({ ...request, manifest });
  const failure = resultOf(report)["firstIncompatibleBehavior"] as {
    phase: string;
    message: string;
  };

  assert.equal(resultOf(report)["outcome"], "fail");
  assert.equal(failure.phase, "build");
  assert.match(failure.message, /did not exit within/);
});

test("a lifecycle command that dies before readiness is a readiness failure, not a slow start", async () => {
  const request = await baseRequest("rsvite");
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { argv: string[]; env?: Record<string, string> }> }[];
  };
  // Serve on a port the readiness check is not watching, then exit immediately.
  manifest.entries[0]!.commands["dev"] = {
    argv: [process.execPath, "-e", "process.exit(0)"],
  };

  const started = Date.now();
  const report = await runCompatibilityCheck({ ...request, manifest });
  const failure = resultOf(report)["firstIncompatibleBehavior"] as { message: string };

  assert.match(failure.message, /exited before it reported readiness/);
  assert.ok(Date.now() - started < 9_000, "it did not wait out the readiness timeout");
});

test("no process from the run's tree survives it", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", { origin: `http://127.0.0.1:${String(port)}` });
  const pidFile = join(request.artifactRoot, "grandchild.pid");
  const manifest = withPort(request.manifest, port, { CHILD_PID_FILE: pidFile });

  await runCompatibilityCheck({ ...request, manifest });

  const grandchild = Number(readFileSync(pidFile, "utf8"));
  await delay(500);
  assert.throws(
    () => process.kill(grandchild, 0),
    "a grandchild of the lifecycle command outlived the run",
  );
});

test("a browser that cannot open the page fails the run", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: createSyntheticBrowser({ failToOpen: "no browser available" }),
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const failure = resultOf(report)["firstIncompatibleBehavior"] as {
    phase: string;
    message: string;
  };

  assert.equal(failure.phase, "browser");
  assert.match(failure.message, /could not open the page/);
});

test("browser errors are normalized onto the result", async () => {
  const port = await freePort();
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser: createSyntheticBrowser({
      openEvents: [{ type: "request-failed", url: "http://127.0.0.1/missing.js", message: "404" }],
    }),
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });

  assert.deepEqual(resultOf(report)["browserErrors"], [
    { type: "request-failure", message: "404", url: "http://127.0.0.1/missing.js" },
  ]);
  assert.equal(resultOf(report)["outcome"], "fail");
});

test("the runner refuses to classify a failure the caller did not classify", async () => {
  const request = await baseRequest("rsvite");
  const manifest = structuredClone(syntheticManifest()) as {
    entries: { commands: Record<string, { env?: Record<string, string> }> }[];
  };
  manifest.entries[0]!.commands["install"]!.env = { EXIT_CODE: "1" };

  await assert.rejects(
    runCompatibilityCheck({
      ...request,
      manifest,
      declared: { ...declaredFor("rsvite"), classifyFailure: () => undefined },
    }),
    /does not classify failures itself/,
  );
});
