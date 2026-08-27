import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { createContractValidators } from "@rsvite/compatibility-contract";
import { readPin } from "../src/index.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const pin = readPin();
const manifest: unknown = JSON.parse(readFileSync(join(repoRoot, "corpus/manifest.json"), "utf8"));

function committed(subject: string): { path: string; result: Record<string, unknown> } {
  const path = join(repoRoot, "corpus/results", pin.entryId, subject, "result.json");
  return { path, result: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> };
}

/** Evidence paths are relative to the result file, and a path nothing is at is not evidence. */
function assertEvidenceExists(path: string, result: Record<string, unknown>): void {
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

test("the committed Vite baseline is accepted with the corpus manifest", () => {
  const { path, result } = committed("vite");
  assertAcceptedWithManifest(path, result);
  assertEvidenceExists(path, result);

  assert.equal(result["outcome"], "pass");
  assert.equal((result["subject"] as { name: string }).name, "vite");
  // The baseline is the original implementation, so it has nothing to fall back to.
  assert.deepEqual(result["explicitFallbacks"], []);
});

test("the baseline records the browser that ran, not the library that launched it", () => {
  const { result } = committed("vite");
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

test("the committed rsvite result is accepted, and says where rsvite diverges first", () => {
  const { path, result } = committed("rsvite");
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

test("both subjects were measured against the same pinned input", () => {
  const entryOf = (subject: string): unknown => committed(subject).result["manifestEntry"];

  assert.deepEqual(entryOf("rsvite"), entryOf("vite"));
  assert.deepEqual(entryOf("vite"), { id: pin.entryId, sourceCommit: pin.commit });
});
