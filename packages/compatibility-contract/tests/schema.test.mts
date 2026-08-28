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

function readPair(relativePath: string): { manifest: unknown; result: unknown } {
  return readExample(relativePath) as { manifest: unknown; result: unknown };
}

function listExamples(relativeDir: string): string[] {
  return readdirSync(`${examplesDir}${relativeDir}`)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function violationMessages(result: ValidationResult): string[] {
  return result.valid ? [] : result.violations.map((violation) => violation.message);
}

function assertAccepted(name: string, result: ValidationResult): void {
  assert.deepEqual(violationMessages(result), [], `${name} should satisfy the contract`);
}

function assertRejectedWith(name: string, result: ValidationResult, expected: string): void {
  assert.equal(result.valid, false, `${name} should be rejected`);
  assert.ok(
    violationMessages(result).some((message) => message.includes(expected)),
    `${name} should be rejected with "${expected}", got ${violationMessages(result).join("; ")}`,
  );
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
  "baseline-declaring-fallbacks.json": "/explicitFallbacks must NOT have more than 0 items",
  "baseline-owned-by-rsvite-javascript.json": "/capabilityOwners/0/owner must be equal to constant",
  "duplicate-capability-owner.json": "/capabilityOwners/1/capability is recorded twice",
  "failure-without-first-incompatible-behavior.json":
    "must have required property 'firstIncompatibleBehavior'",
  "fallback-capability-claimed-for-rust.json":
    "/explicitFallbacks/0/capabilities/0 was carried by a fallback, so it cannot be owned by rust",
  "fallback-capability-without-owner.json":
    "/explicitFallbacks/0/capabilities/0 has no owner in /capabilityOwners",
  "finished-before-started.json": "/finishedAt is earlier than /startedAt",
  "measurement-without-cache-state.json": "/measurements must have required property 'cacheState'",
  "missing-capability-owner.json": "must have required property 'capabilityOwners'",
  "missing-correctness-outcome.json": "must have required property 'outcome'",
  "missing-javascript-api-level.json": "must have required property 'javascriptApiLevel'",
  "node-version-with-trailing-text.json": "/environment/nodeVersion must match pattern",
  "pass-carrying-failure-fields.json": "/firstIncompatibleBehavior",
  "source-commit-not-a-sha.json": "/manifestEntry/sourceCommit must match pattern",
  "timestamp-not-iso-8601.json": "/startedAt must match format",
  "undeclared-fallbacks.json": "must have required property 'explicitFallbacks'",
  "unknown-capability-owner.json":
    "/capabilityOwners/0/capability must be equal to one of the allowed values",
};

/** A manifest and a result that are each shape-valid can still be incoherent together. */
const rejectedPairs: Record<string, string> = {
  "api-level-above-entry.json":
    "/javascriptApiLevel is higher than the level the manifest entry declares",
  "capability-not-declared-by-entry.json":
    "/capabilityOwners/0/capability is not declared by the manifest entry",
  "entry-id-not-in-manifest.json": "/manifestEntry/id names no entry in the manifest",
  "fallback-capability-not-declared-by-entry.json":
    "/explicitFallbacks/0/capabilities/0 is not declared by the manifest entry",
  "package-manager-differs-from-lockfile.json":
    "/environment/packageManager/name does not match the manifest entry's lockfile package manager",
  "source-commit-does-not-match-entry.json":
    "/manifestEntry/sourceCommit does not match the manifest entry's source commit",
};

test("every valid corpus manifest example satisfies the contract", () => {
  const names = listExamples("corpus-manifest/valid");
  assert.ok(names.length > 0, "expected at least one valid corpus manifest example");

  for (const name of names) {
    assertAccepted(
      name,
      validators.validateCorpusManifest(readExample(`corpus-manifest/valid/${name}`)),
    );
  }
});

test("every valid raw result example satisfies the contract", () => {
  const names = listExamples("raw-result/valid");
  assert.ok(names.length > 0, "expected at least one valid raw result example");

  for (const name of names) {
    assertAccepted(name, validators.validateRawResult(readExample(`raw-result/valid/${name}`)));
  }
});

test("every rejected corpus manifest example is rejected for its own reason", () => {
  const names = listExamples("corpus-manifest/invalid");
  assert.deepEqual(
    names,
    Object.keys(rejectedManifests).sort(),
    "each rejected example needs an expectation",
  );

  for (const name of names) {
    assertRejectedWith(
      name,
      validators.validateCorpusManifest(readExample(`corpus-manifest/invalid/${name}`)),
      rejectedManifests[name] as string,
    );
  }
});

test("every rejected raw result example is rejected for its own reason", () => {
  const names = listExamples("raw-result/invalid");
  assert.deepEqual(
    names,
    Object.keys(rejectedResults).sort(),
    "each rejected example needs an expectation",
  );

  for (const name of names) {
    assertRejectedWith(
      name,
      validators.validateRawResult(readExample(`raw-result/invalid/${name}`)),
      rejectedResults[name] as string,
    );
  }
});

test("a coherent manifest and result pass canonical pair validation", () => {
  const names = listExamples("pair/valid");
  assert.ok(names.length > 0, "expected at least one valid pair example");

  for (const name of names) {
    const { manifest, result } = readPair(`pair/valid/${name}`);
    assertAccepted(name, validators.validateResultAgainstManifest(manifest, result));
    // The halves are individually valid, which is what makes the pair check load-bearing.
    assertAccepted(name, validators.validateCorpusManifest(manifest));
    assertAccepted(name, validators.validateRawResult(result));
  }
});

test("an incoherent pair is rejected even though both documents are valid alone", () => {
  const names = listExamples("pair/invalid");
  assert.deepEqual(
    names,
    Object.keys(rejectedPairs).sort(),
    "each rejected pair needs an expectation",
  );

  for (const name of names) {
    const { manifest, result } = readPair(`pair/invalid/${name}`);
    assertAccepted(`${name} manifest`, validators.validateCorpusManifest(manifest));
    assertAccepted(`${name} result`, validators.validateRawResult(result));
    assertRejectedWith(
      name,
      validators.validateResultAgainstManifest(manifest, result),
      rejectedPairs[name] as string,
    );
  }
});

test("pair validation reports a malformed document instead of its relationships", () => {
  const { manifest } = readPair("pair/valid/rsvite-html-pass.json");
  const malformed = readExample("raw-result/invalid/missing-capability-owner.json");

  assertRejectedWith(
    "missing-capability-owner.json",
    validators.validateResultAgainstManifest(manifest, malformed),
    "must have required property 'capabilityOwners'",
  );
});

test("pair validation inherits the fallback ownership rule", () => {
  const { manifest, result } = readPair("pair/fallback-capability-without-owner.json");

  // The entry declares the capability, so nothing else can account for its absence: a
  // fallback carried it, and the ownership record simply does not mention it.
  assertAccepted(
    "fallback-capability-without-owner.json manifest",
    validators.validateCorpusManifest(manifest),
  );
  assertRejectedWith(
    "fallback-capability-without-owner.json",
    validators.validateResultAgainstManifest(manifest, result),
    "/explicitFallbacks/0/capabilities/0 has no owner in /capabilityOwners",
  );
});

test("a run that failed at install still records what it set out to verify", () => {
  const result = readExample("raw-result/valid/rsvite-install-failure.json") as {
    firstIncompatibleBehavior: { phase: string };
    capabilityOwners: unknown[];
  };

  // Ownership is the selected subset for the run, not the subset it reached, so a setup
  // failure neither has to invent capabilities nor file itself as measuring nothing.
  assert.equal(result.firstIncompatibleBehavior.phase, "install");
  assert.ok(result.capabilityOwners.length > 0);
  assertAccepted("rsvite-install-failure.json", validators.validateRawResult(result));
});

test("an unknown capability is refused on both sides of the contract", () => {
  const manifest = readExample("corpus-manifest/invalid/unknown-capability.json");
  const result = readExample("raw-result/invalid/unknown-capability-owner.json");

  // One shared capability definition, referenced by both schemas, is what makes these agree.
  assertRejectedWith(
    "unknown-capability.json",
    validators.validateCorpusManifest(manifest),
    "/entries/0/expectedCapabilities/0 must be equal to one of the allowed values",
  );
  assertRejectedWith(
    "unknown-capability-owner.json",
    validators.validateRawResult(result),
    "/capabilityOwners/0/capability must be equal to one of the allowed values",
  );
});

test("an input that only serves an HTML entry can say so", () => {
  const manifest = readExample("corpus-manifest/valid/html-entry-slice.json") as {
    entries: { expectedCapabilities: string[] }[];
  };

  assert.deepEqual(manifest.entries[0]?.expectedCapabilities, ["html"]);
  assertAccepted("html-entry-slice.json", validators.validateCorpusManifest(manifest));
});

test("v1 requires the declared HMR edit and expected text as runner inputs", () => {
  const manifest = readExample("corpus-manifest/valid/mixed-corpus.json") as {
    entries: { browserAcceptance?: { hmr?: Record<string, unknown> } }[];
  };
  const withoutEdit = structuredClone(manifest);
  const withoutExpectedText = structuredClone(manifest);
  delete withoutEdit.entries[0]?.browserAcceptance?.hmr?.["edit"];
  delete withoutExpectedText.entries[0]?.browserAcceptance?.hmr?.["expectedText"];

  assertRejectedWith(
    "HMR acceptance without edit",
    validators.validateCorpusManifest(withoutEdit),
    "must have required property 'edit'",
  );
  assertRejectedWith(
    "HMR acceptance without expectedText",
    validators.validateCorpusManifest(withoutExpectedText),
    "must have required property 'expectedText'",
  );
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
