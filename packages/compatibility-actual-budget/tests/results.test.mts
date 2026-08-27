import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { createContractValidators } from "@rsvite/compatibility-contract";
import { actualBudgetEntry, readPin } from "../src/index.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const pin = readPin();
const manifest: unknown = JSON.parse(readFileSync(join(repoRoot, "corpus/manifest.json"), "utf8"));

type Result = Record<string, unknown>;

function committed(subject: string, lifecycle: string): { path: string; result: Result } {
  const path = join(repoRoot, "corpus/results", pin.entryId, subject, lifecycle, "result.json");
  return { path, result: JSON.parse(readFileSync(path, "utf8")) as Result };
}

/** Evidence paths are relative to the result file, and a path nothing is at is not evidence. */
function assertEvidenceExists(path: string, result: Result): void {
  const paths = result["artifactPaths"];
  assert.ok(Array.isArray(paths) && paths.length > 0, `${path} names no evidence`);
  for (const entry of paths) {
    assert.equal(typeof entry, "string");
    const relative = entry as string;
    assert.ok(!isAbsolute(relative) && !relative.split(/[\\/]/).includes(".."), relative);
    assert.ok(statSync(join(dirname(path), relative)).isFile(), `${relative} is missing`);
  }
}

function assertAcceptedWithManifest(path: string, result: unknown): void {
  const check = createContractValidators().validateResultAgainstManifest(manifest, result);
  assert.deepEqual(
    check.valid ? [] : check.violations.map((violation) => violation.message),
    [],
    `${path} is not accepted with the corpus manifest`,
  );
}

function owners(result: Result): Record<string, string> {
  const declared = result["capabilityOwners"] as { capability: string; owner: string }[];
  return Object.fromEntries(declared.map((entry) => [entry.capability, entry.owner]));
}

test("the corpus entry is the one the pin generates, including what the build reads", () => {
  const entries = (manifest as { entries: { id: string }[] }).entries;
  assert.deepEqual(
    entries.find((entry) => entry.id === pin.entryId),
    actualBudgetEntry(pin),
    "the committed entry has drifted away from the pin it is generated from",
  );
});

test("the committed development baseline is accepted with the corpus manifest", () => {
  const { path, result } = committed("vite", "dev");
  assertAcceptedWithManifest(path, result);
  assertEvidenceExists(path, result);

  assert.equal(result["outcome"], "pass");
  assert.equal((result["subject"] as { name: string }).name, "vite");
  // The baseline is the original implementation, so it has nothing to fall back to.
  assert.deepEqual(result["explicitFallbacks"], []);
  assert.equal(owners(result)["hmr-without-full-reload"], "vite");
});

test("the baseline records the browser that ran, not the library that launched it", () => {
  const { result } = committed("vite", "dev");
  const browser = (result["environment"] as { browser?: { name: string; version: string } })
    .browser;

  assert.equal(browser?.name, "chromium");
  // Chromium is versioned in four parts. Playwright's own package version has three, and it was
  // recorded here once — the two are different numbers about different things.
  assert.match(
    browser?.version ?? "",
    /^\d+\.\d+\.\d+\.\d+$/,
    "the recorded browser version is not a Chromium version",
  );
});

test("the project's own acceptance is committed beside the development baseline", () => {
  const { path } = committed("vite", "dev");
  // Produced by the recorder rather than by the runner, so the result does not name it — but it
  // is the evidence that the application worked against the server the update was measured on.
  for (const log of ["upstream-e2e.stdout.log", "upstream-e2e.stderr.log"]) {
    assert.ok(statSync(join(dirname(path), log)).isFile(), `${log} is missing`);
  }
});

test("the required build capability is carried by a result, not by a loose log", () => {
  const { path, result } = committed("vite", "build");
  assertAcceptedWithManifest(path, result);
  assertEvidenceExists(path, result);

  assert.equal(result["outcome"], "pass");
  assert.equal(owners(result)["build-output"], "vite");
  // One result describes one lifecycle command; the entry's coverage is what the results
  // establish together, so the development result must not claim this one's capability.
  assert.equal(owners(committed("vite", "dev").result)["build-output"], undefined);
});

test("the committed rsvite result is accepted, and says where rsvite diverges first", () => {
  const { path, result } = committed("rsvite", "dev");
  assertAcceptedWithManifest(path, result);
  assertEvidenceExists(path, result);

  assert.equal(result["outcome"], "fail");
  assert.equal((result["subject"] as { name: string }).name, "rsvite");
  // The finding is the first lifecycle step, not a summary of everything downstream of it.
  assert.equal((result["firstIncompatibleBehavior"] as { phase: string }).phase, "dev");
  assert.equal(
    (result["failureClassification"] as { kind: string }).kind,
    "current-compatibility-requirement",
  );
});

test("every result was measured against the same pinned input", () => {
  const expected = { id: pin.entryId, sourceCommit: pin.commit };
  for (const [subject, lifecycle] of [
    ["vite", "dev"],
    ["vite", "build"],
    ["rsvite", "dev"],
  ] as const) {
    assert.deepEqual(committed(subject, lifecycle).result["manifestEntry"], expected);
  }
});
