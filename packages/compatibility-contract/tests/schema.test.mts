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

function violationMessages(result: ValidationResult): string[] {
  return result.valid ? [] : result.violations.map((violation) => violation.message);
}

/**
 * Each rejected example names the complaint the contract must produce. Asserting the specific
 * message, rather than only that the document was rejected, keeps a fixture from passing this
 * test for the wrong reason after an unrelated edit makes it malformed somewhere else. Several
 * of these are missing-property cases that all report at the document root, so the location
 * alone would not tell them apart.
 */
const rejectedManifests: Record<string, string> = {
  "duplicate-entry-id.json": "/entries/1/id duplicates an earlier entry id",
  "hmr-sentinel-in-local-storage.json":
    "/entries/0/browserAcceptance/hmr/sentinelStorage must be equal to constant",
  "real-project-without-dev-command.json": "/entries/0/commands must have required property 'dev'",
  "source-pinned-to-a-branch.json": "/entries/0/source/commit must match pattern",
  "source-without-license.json": "/entries/0/source must have required property 'license'",
  "unknown-capability.json":
    "/entries/0/expectedCapabilities/0 must be equal to one of the allowed values",
  "unnamespaced-adapter-extension.json": "/entries/0/extensions",
};

const rejectedResults: Record<string, string> = {
  "failure-without-first-incompatible-behavior.json":
    "must have required property 'firstIncompatibleBehavior'",
  "measurement-without-cache-state.json": "/measurements must have required property 'cacheState'",
  "missing-capability-owner.json": "must have required property 'capabilityOwner'",
  "missing-correctness-outcome.json": "must have required property 'outcome'",
  "missing-javascript-api-level.json": "must have required property 'javascriptApiLevel'",
  "source-commit-not-a-sha.json": "/manifestEntry/sourceCommit must match pattern",
  "timestamp-not-iso-8601.json": "/startedAt must match format",
  "undeclared-fallbacks.json": "must have required property 'explicitFallbacks'",
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
      violationMessages(result).some((message) =>
        message.includes(rejectedManifests[name] as string),
      ),
      `${name} should be rejected with "${rejectedManifests[name]}", got ${violationMessages(result).join("; ")}`,
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
      violationMessages(result).some((message) =>
        message.includes(rejectedResults[name] as string),
      ),
      `${name} should be rejected with "${rejectedResults[name]}", got ${violationMessages(result).join("; ")}`,
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
  assert.ok(violationMessages(result).some((message) => message.startsWith("/contractVersion")));
});
