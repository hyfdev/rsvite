import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { createContractValidators, type ValidationResult } from "../src/index.ts";

const examplesDir = fileURLToPath(new URL("../examples/", import.meta.url));
const validators = createContractValidators();

function readExample(relativePath: string): unknown {
  return JSON.parse(readFileSync(`${examplesDir}${relativePath}`, "utf8"));
}

function listExamples(relativeDir: string): string[] {
  return readdirSync(`${examplesDir}${relativeDir}`)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function violationPaths(result: ValidationResult): string[] {
  return result.valid ? [] : result.violations.map((violation) => violation.path);
}

/**
 * Each rejected example names the location the contract must complain about. Asserting the
 * location, not just "invalid", keeps a fixture from passing this test for the wrong reason
 * after an unrelated edit makes it malformed somewhere else.
 */
const rejectedManifests: Record<string, string> = {
  "duplicate-entry-id.json": "/entries/1/id",
  "hmr-sentinel-in-local-storage.json": "/entries/0/browserAcceptance/hmr/sentinelStorage",
  "real-project-without-dev-command.json": "/entries/0/commands",
  "source-pinned-to-a-branch.json": "/entries/0/source/commit",
  "source-without-license.json": "/entries/0/source",
  "unknown-capability.json": "/entries/0/expectedCapabilities/0",
  "unnamespaced-adapter-extension.json": "/entries/0/extensions",
};

const rejectedResults: Record<string, string> = {
  "failure-without-first-incompatible-behavior.json": "",
  "measurement-without-cache-state.json": "/measurements",
  "missing-capability-owner.json": "",
  "missing-correctness-outcome.json": "",
  "source-commit-not-a-sha.json": "/manifestEntry/sourceCommit",
  "timestamp-not-iso-8601.json": "/startedAt",
  "undeclared-fallbacks.json": "",
};

test("every valid corpus manifest example satisfies the contract", () => {
  const names = listExamples("corpus-manifest/valid");
  assert.ok(names.length > 0, "expected at least one valid corpus manifest example");

  for (const name of names) {
    const result = validators.validateCorpusManifest(readExample(`corpus-manifest/valid/${name}`));
    assert.deepEqual(
      result.valid ? [] : result.violations,
      [],
      `${name} should satisfy the contract`,
    );
  }
});

test("every valid raw result example satisfies the contract", () => {
  const names = listExamples("raw-result/valid");
  assert.ok(names.length > 0, "expected at least one valid raw result example");

  for (const name of names) {
    const result = validators.validateRawResult(readExample(`raw-result/valid/${name}`));
    assert.deepEqual(
      result.valid ? [] : result.violations,
      [],
      `${name} should satisfy the contract`,
    );
  }
});

test("every rejected corpus manifest example is rejected at the documented location", () => {
  const names = listExamples("corpus-manifest/invalid");
  assert.deepEqual(
    names,
    Object.keys(rejectedManifests).sort(),
    "each rejected example needs an expectation",
  );

  for (const name of names) {
    const result = validators.validateCorpusManifest(
      readExample(`corpus-manifest/invalid/${name}`),
    );
    assert.equal(result.valid, false, `${name} should be rejected`);
    assert.ok(
      violationPaths(result).includes(rejectedManifests[name] as string),
      `${name} should be rejected at ${rejectedManifests[name]}, got ${violationPaths(result).join(", ")}`,
    );
  }
});

test("every rejected raw result example is rejected at the documented location", () => {
  const names = listExamples("raw-result/invalid");
  assert.deepEqual(
    names,
    Object.keys(rejectedResults).sort(),
    "each rejected example needs an expectation",
  );

  for (const name of names) {
    const result = validators.validateRawResult(readExample(`raw-result/invalid/${name}`));
    assert.equal(result.valid, false, `${name} should be rejected`);
    assert.ok(
      violationPaths(result).includes(rejectedResults[name] as string),
      `${name} should be rejected at "${rejectedResults[name]}", got ${violationPaths(result).join(", ")}`,
    );
  }
});

test("an input that only serves an HTML entry can say so", () => {
  const manifest = readExample("corpus-manifest/valid/html-entry-slice.json") as {
    entries: { expectedCapabilities: string[] }[];
  };

  assert.deepEqual(manifest.entries[0]?.expectedCapabilities, ["html"]);
  assert.equal(validators.validateCorpusManifest(manifest).valid, true);
});

test("a document from the wrong side of the contract is rejected", () => {
  const manifest = readExample("corpus-manifest/valid/mixed-corpus.json");
  const rawResult = readExample("raw-result/valid/vite-baseline-pass.json");

  assert.equal(validators.validateRawResult(manifest).valid, false);
  assert.equal(validators.validateCorpusManifest(rawResult).valid, false);
});

test("a contract version the schema does not define is rejected", () => {
  const manifest = readExample("corpus-manifest/valid/mixed-corpus.json") as Record<
    string,
    unknown
  >;

  const result = validators.validateCorpusManifest({ ...manifest, contractVersion: 2 });

  assert.equal(result.valid, false);
  assert.ok(violationPaths(result).includes("/contractVersion"));
});
