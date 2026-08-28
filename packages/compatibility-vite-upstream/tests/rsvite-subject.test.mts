import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { assertRsviteResultSubjectIsCurrent } from "@rsvite/compatibility-rsvite-workspace";
import { createContractValidators } from "@rsvite/compatibility-contract";
import {
  HTML_PRESERVE_COMMENTS_ENTRY_ID,
  VITE_UPSTREAM_VITEST_VERSION,
  assertExpectedRsviteHtmlPreserveCommentsExecution,
  assertResultArtifactsExist,
  assertViteUpstreamBrowserObservation,
  manifestForRsviteHtmlPreserveComments,
  readCorpusManifest,
  rsviteBaselineResultPath,
  rsviteUpstreamConfigPath,
  viteBaselineResultPath,
} from "../src/index.ts";
import { pairedRecordingEnvironment, runRsvitePair } from "../scripts/record-rsvite-pair.mts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function entryOf(manifest: unknown): Record<string, unknown> {
  const entries = (manifest as { entries?: unknown }).entries;
  assert.ok(Array.isArray(entries));
  const entry = entries.find(
    (candidate) => (candidate as { id?: unknown }).id === HTML_PRESERVE_COMMENTS_ENTRY_ID,
  );
  assert.ok(entry);
  return entry as Record<string, unknown>;
}

function commandsOf(entry: Record<string, unknown>): Record<string, { argv: string[] }> {
  return entry["commands"] as Record<string, { argv: string[] }>;
}

function resultFailure(result: Record<string, unknown>): {
  failure: { phase: string; message: string };
} {
  const failure = result["firstIncompatibleBehavior"] as { phase: string; message: string };
  return { failure: { phase: failure.phase, message: failure.message } };
}

function runCurrentRsviteCase(extraSetup?: string) {
  const command = commandsOf(entryOf(manifestForRsviteHtmlPreserveComments()))["test"] as {
    argv: string[];
    env?: Record<string, string>;
  };
  const probe = spawnSync(command.argv[0], command.argv.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...command.env,
      NO_COLOR: "1",
      ...(extraSetup === undefined ? {} : { RSVITE_EXTRA_TEST_SETUP: extraSetup }),
    },
    timeout: 30_000,
  });
  return { command, probe };
}

test("the rsvite subject keeps the pinned install and runs the exact imported test", () => {
  const canonical = readCorpusManifest();
  const derived = manifestForRsviteHtmlPreserveComments(canonical);
  const canonicalCommands = commandsOf(entryOf(canonical));
  const derivedCommands = commandsOf(entryOf(derived));

  assert.deepEqual(derivedCommands["install"], canonicalCommands["install"]);
  assert.equal(derivedCommands["test"]?.argv[1], "run");
  assert.equal(derivedCommands["test"]?.argv[2], "--config");
  assert.equal(derivedCommands["test"]?.argv[3], rsviteUpstreamConfigPath);
  assert.equal(isAbsolute(derivedCommands["test"]?.argv[0] ?? ""), true);
  assert.equal(
    (derivedCommands["test"] as { env?: Record<string, string> }).env?.["NO_COLOR"],
    "1",
  );
  assert.deepEqual(commandsOf(entryOf(canonical)), canonicalCommands);
});

test("the recorder binds the rsvite case to the pinned browser, project, and Vitest", () => {
  const modulePath = "/pinned-vite/node_modules/playwright-chromium/index.js";
  const upstreamRoot = "/pinned-vite/playground/html";
  const vitestExecutable = "/pinned-vite/node_modules/vitest/vitest.mjs";
  const derived = manifestForRsviteHtmlPreserveComments(undefined, {
    playwrightModule: modulePath,
    upstreamRoot,
    viteCheckout: "/pinned-vite",
    vitestExecutable,
  });
  const testCommand = commandsOf(entryOf(derived))["test"] as {
    argv: string[];
    env?: Record<string, string>;
  };
  assert.equal(testCommand.argv[0], vitestExecutable);
  assert.equal(testCommand.env?.["RSVITE_PLAYWRIGHT_MODULE"], modulePath);
  assert.equal(testCommand.env?.["RSVITE_UPSTREAM_ROOT"], upstreamRoot);
  assert.equal(testCommand.env?.["RSVITE_VITE_CHECKOUT"], "/pinned-vite");
});

test("the supported recording task declares both external inputs and builds the binding", () => {
  const config = readFileSync(join(repoRoot, "vite.config.ts"), "utf8");
  const recorder = readFileSync(
    join(repoRoot, "packages/compatibility-vite-upstream/scripts/record-rsvite-baseline.mts"),
    "utf8",
  );
  const pairRecorder = readFileSync(
    join(repoRoot, "packages/compatibility-vite-upstream/scripts/record-rsvite-pair.mts"),
    "utf8",
  );
  assert.match(config, /"record:rsvite-upstream:baseline"/);
  assert.match(
    config,
    /"record:rsvite-upstream:baseline"[\s\S]*?record-rsvite-pair\.mts[\s\S]*?cache:\s*false/,
  );
  assert.match(pairRecorder, /\["VITE_CHECKOUT", "RUNNER_IMAGE"\]/);
  assert.match(
    recorder,
    /viteVitestInstallation\(checkout\)[\s\S]*?playwrightModule,[\s\S]*?upstreamRoot: join\(checkout, "playground\/html"\)[\s\S]*?viteCheckout: checkout,[\s\S]*?vitestExecutable: vitest\.executable/,
  );
  assert.match(recorder, /publishViteUpstreamBrowserObservation\(report, manifest\)/);
  assert.match(pairRecorder, /record:vite-upstream:baseline/);
  const viteRecorder = readFileSync(
    join(repoRoot, "packages/compatibility-vite-upstream/scripts/record-vite-baseline.mts"),
    "utf8",
  );
  assert.match(viteRecorder, /publishViteUpstreamBrowserObservation\(report, manifest\)/);
});

test("the paired recorder validates the workspace before preparation or evidence writes", () => {
  const calls: string[] = [];
  runRsvitePair({
    preflight: () => calls.push("preflight"),
    runTask: (task) => calls.push(task),
    recordRsvite: () => calls.push("record:rsvite"),
  });
  // The native build is part of preflight, not a separate step: identity, build and workspace
  // command are settled together before anything external is touched or any evidence is written.
  assert.deepEqual(calls, ["preflight", "record:vite-upstream:baseline", "record:rsvite"]);

  const effects: string[] = [];
  assert.throws(
    () =>
      runRsvitePair({
        preflight: () => {
          throw new Error("invalid workspace");
        },
        runTask: (task) => effects.push(task),
        recordRsvite: () => effects.push("record:rsvite"),
      }),
    /invalid workspace/,
  );
  assert.deepEqual(effects, []);
});

test("the whole-execution validator rejects non-Vitest and wrong-phase failures", () => {
  assert.throws(
    () =>
      assertExpectedRsviteHtmlPreserveCommentsExecution(
        { failure: { phase: "test", message: "test exited with code 1" } },
        { stdout: "Error: browser process crashed", stderr: "" },
      ),
    /refusing to accept the expected C0 execution/,
  );
  assert.throws(
    () =>
      assertExpectedRsviteHtmlPreserveCommentsExecution(
        { failure: { phase: "install", message: "install exited with code 1" } },
        { stdout: "{}", stderr: "" },
      ),
    /refusing to accept the expected C0 execution/,
  );
});

test("the uncached paired recorder requires and preserves its declared inputs", () => {
  const environment = pairedRecordingEnvironment({
    HOME: "/home/recorder",
    PATH: "/bin",
    VITE_CHECKOUT: "/source/vite",
    RUNNER_IMAGE: "ubuntu-24.04",
    RUSTFLAGS: "-D warnings",
  });

  assert.deepEqual(environment, {
    HOME: "/home/recorder",
    PATH: "/bin",
    VITE_CHECKOUT: "/source/vite",
    RUNNER_IMAGE: "ubuntu-24.04",
    RUSTFLAGS: "-D warnings",
  });
  assert.throws(
    () => pairedRecordingEnvironment({ RUNNER_IMAGE: "ubuntu-24.04" }),
    /VITE_CHECKOUT must identify/,
  );
});

test("the paired results describe the same pinned input and environment", () => {
  const manifest = readCorpusManifest();
  const validators = createContractValidators();
  const vite = JSON.parse(readFileSync(viteBaselineResultPath, "utf8")) as Record<string, unknown>;
  const rsvite = JSON.parse(readFileSync(rsviteBaselineResultPath, "utf8")) as Record<
    string,
    unknown
  >;

  for (const [path, result] of [
    [viteBaselineResultPath, vite],
    [rsviteBaselineResultPath, rsvite],
  ] as const) {
    const check = validators.validateResultAgainstManifest(manifest, result);
    assert.deepEqual(
      check.valid ? [] : check.violations.map((violation) => violation.message),
      [],
      `${path} is not accepted with the corpus manifest`,
    );
    assertResultArtifactsExist(path, result);
  }

  assert.deepEqual(rsvite["manifestEntry"], vite["manifestEntry"]);
  assert.deepEqual(rsvite["environment"], vite["environment"]);
  for (const result of [vite, rsvite]) {
    assert.doesNotThrow(() => assertViteUpstreamBrowserObservation(result));
  }
  const undisclosed = structuredClone(vite);
  delete undisclosed["extensions"];
  assert.throws(
    () => assertViteUpstreamBrowserObservation(undisclosed),
    /must disclose that its nested browser was not runner-observed/,
  );
  assert.equal(
    (rsvite["command"] as { cwd: string }).cwd,
    (vite["command"] as { cwd: string }).cwd,
  );
  const rsviteCommand = rsvite["command"] as { argv: string[]; cwd: string };
  assert.equal(rsviteCommand.argv[1], "run");
  assert.equal(rsviteCommand.argv[2], "--config");
  assert.equal(isAbsolute(rsviteCommand.argv[0] ?? ""), true);
  assert.equal(relative(rsviteCommand.cwd, rsviteCommand.argv[0]).startsWith(".."), false);
  assert.match(
    rsviteCommand.argv[0],
    new RegExp(
      `vitest@${VITE_UPSTREAM_VITEST_VERSION.replaceAll(".", "\\.")}[^/]*\\/node_modules\\/vitest\\/vitest\\.mjs$`,
    ),
  );
  assert.equal((vite["subject"] as { name: string }).name, "vite");
  assert.equal(vite["outcome"], "pass");
  assert.equal(vite["javascriptApiLevel"], "C2");
  assert.deepEqual(vite["capabilityOwners"], [{ capability: "html", owner: "vite" }]);
  assert.equal((rsvite["subject"] as { name: string }).name, "rsvite");
  assert.equal((rsvite["subject"] as { version: string }).version, "0.0.0");
  assert.match((rsvite["subject"] as { commit: string }).commit, /^[0-9a-f]{40}$/);
  assert.doesNotThrow(() => {
    assertRsviteResultSubjectIsCurrent(rsvite["subject"]);
  });
  assert.equal(rsvite["outcome"], "fail");
  assert.equal(rsvite["javascriptApiLevel"], "C0");
  assert.deepEqual(rsvite["capabilityOwners"], [{ capability: "html", owner: "rust" }]);
  assert.deepEqual(rsvite["explicitFallbacks"], []);
  assert.equal((rsvite["firstIncompatibleBehavior"] as { phase: string }).phase, "test");
  assert.doesNotThrow(() =>
    assertExpectedRsviteHtmlPreserveCommentsExecution(resultFailure(rsvite), {
      stdout: readFileSync(join(dirname(rsviteBaselineResultPath), "test.stdout.log"), "utf8"),
      stderr: readFileSync(join(dirname(rsviteBaselineResultPath), "test.stderr.log"), "utf8"),
    }),
  );
  const classification = rsvite["failureClassification"] as {
    kind: string;
    evidence: string;
  };
  assert.equal(classification.kind, "current-compatibility-requirement");
  assert.match(classification.evidence, /transformIndexHtml/);
  assert.match(classification.evidence, /rsvite C0 subject ignores configuration and Plugin API/);
});

test("the exact imported case still produces the committed rsvite outcome", () => {
  const result = JSON.parse(readFileSync(rsviteBaselineResultPath, "utf8")) as Record<
    string,
    unknown
  >;
  const { probe } = runCurrentRsviteCase();
  const output = `${probe.stdout}\n${probe.stderr}`;

  assert.equal(result["outcome"], "fail");
  assert.equal(probe.status, 1, output);
  assert.doesNotThrow(() =>
    assertExpectedRsviteHtmlPreserveCommentsExecution(resultFailure(result), {
      stdout: probe.stdout,
      stderr: probe.stderr,
    }),
  );
});

test("the whole-execution gate rejects the selected assertion plus an afterAll failure", () => {
  const setup = join(
    repoRoot,
    "packages/compatibility-vite-upstream/tests/fixtures/failing-after-all.mjs",
  );
  const { probe } = runCurrentRsviteCase(setup);
  assert.equal(probe.status, 1, `${probe.stdout}\n${probe.stderr}`);
  assert.match(probe.stdout, /independent teardown failure/);
  assert.throws(
    () =>
      assertExpectedRsviteHtmlPreserveCommentsExecution(
        { failure: { phase: "test", message: "test exited with code 1" } },
        { stdout: probe.stdout, stderr: probe.stderr },
      ),
    /refusing to accept the expected C0 execution/,
  );
});

test("the whole-execution gate rejects the selected assertion plus an unhandled error", () => {
  const setup = join(
    repoRoot,
    "packages/compatibility-vite-upstream/tests/fixtures/failing-unhandled.mjs",
  );
  const { probe } = runCurrentRsviteCase(setup);
  assert.equal(probe.status, 1, `${probe.stdout}\n${probe.stderr}`);
  assert.match(probe.stderr, /independent unhandled failure/);
  assert.throws(
    () =>
      assertExpectedRsviteHtmlPreserveCommentsExecution(
        { failure: { phase: "test", message: "test exited with code 1" } },
        { stdout: probe.stdout, stderr: probe.stderr },
      ),
    /refusing to accept the expected C0 execution/,
  );
});
