import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  HTML_PRESERVE_COMMENTS_ENTRY_ID,
  VITE_UPSTREAM_COMMIT,
  VITE_UPSTREAM_REPOSITORY,
  checkImportedFileProvenance,
  htmlPreserveCommentsAdapter,
  readCorpusManifest,
  readProvenance,
  validateCorpusManifestDocument,
} from "../src/index.ts";

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

test("every imported file matches the recorded upstream digest", () => {
  const check = checkImportedFileProvenance();
  assert.deepEqual(
    check.valid ? [] : check.violations,
    [],
    check.valid ? "" : check.violations.map((v) => `${v.path} ${v.message}`).join("\n"),
  );
});

test("an unrecorded edit to an imported file is rejected", () => {
  const provenance = structuredClone(readProvenance()) as {
    files: { dest: string; sha256: string }[];
  };
  const license = provenance.files.find((file) => file.dest === "LICENSE");
  assert.ok(license);
  license.sha256 = "0".repeat(64);

  const check = checkImportedFileProvenance(provenance);
  assert.equal(check.valid, false);
  assert.ok(
    check.valid === false &&
      check.violations.some(
        (violation) =>
          violation.path === "LICENSE" && violation.message.includes("recorded upstream digest"),
      ),
    JSON.stringify(check),
  );
});

test("a vendored path missing from the provenance file list is rejected", () => {
  const provenance = structuredClone(readProvenance()) as {
    files: { source: string; dest: string; sha256: string }[];
  };
  provenance.files = provenance.files.filter((file) => file.dest !== "LICENSE");

  const check = checkImportedFileProvenance(provenance);
  assert.equal(check.valid, false);
  assert.ok(
    check.valid === false &&
      check.violations.some(
        (violation) => violation.path === "LICENSE" && violation.message.includes("not recorded"),
      ),
    JSON.stringify(check),
  );
});

test("an exception is accepted only when it names the current digest and a reason", () => {
  const provenance = structuredClone(readProvenance()) as {
    files: { dest: string; sha256: string }[];
    exceptions: { dest: string; sha256: string; reason: string }[];
  };
  const license = provenance.files.find((file) => file.dest === "LICENSE");
  assert.ok(license);
  const upstreamDigest = license.sha256;
  license.sha256 = "0".repeat(64);

  provenance.exceptions = [{ dest: "LICENSE", sha256: upstreamDigest, reason: "" }];
  const missingReason = checkImportedFileProvenance(provenance);
  assert.equal(missingReason.valid, false);

  provenance.exceptions[0]!.reason = "recorded local edit for this check";
  provenance.exceptions[0]!.sha256 = "1".repeat(64);
  const digestMismatch = checkImportedFileProvenance(provenance);
  assert.equal(digestMismatch.valid, false);
  assert.ok(
    digestMismatch.valid === false &&
      digestMismatch.violations.some((violation) =>
        violation.message.includes("recorded exception digest"),
      ),
    JSON.stringify(digestMismatch),
  );

  provenance.exceptions[0]!.sha256 = upstreamDigest;
  const recorded = checkImportedFileProvenance(provenance);
  assert.deepEqual(
    recorded.valid ? [] : recorded.violations,
    [],
    recorded.valid ? "" : recorded.violations.map((v) => `${v.path} ${v.message}`).join("\n"),
  );
});

test("the corpus manifest is accepted by the canonical validator", () => {
  const manifest = readCorpusManifest();
  const check = validateCorpusManifestDocument(manifest);
  assert.deepEqual(
    check.valid ? [] : check.violations,
    [],
    check.valid ? "" : check.violations.map((v) => v.message).join("\n"),
  );

  const entry = asRecord((asRecord(manifest)["entries"] as unknown[])[0]!);
  assert.equal(entry["id"], HTML_PRESERVE_COMMENTS_ENTRY_ID);
  assert.equal(entry["kind"], "vite-upstream-e2e");
  assert.equal(asRecord(entry["source"])["commit"], VITE_UPSTREAM_COMMIT);
  assert.equal(asRecord(entry["source"])["repository"], VITE_UPSTREAM_REPOSITORY);
  assert.equal(asRecord(asRecord(entry["source"])["license"])["path"], "LICENSE");
  assert.equal(asRecord(asRecord(entry["lockfile"])["packageManager"])["version"], "10.34.5");

  assert.equal(htmlPreserveCommentsAdapter.entryId, HTML_PRESERVE_COMMENTS_ENTRY_ID);
  assert.equal(htmlPreserveCommentsAdapter.spec, "playground/html/__tests__/html.spec.ts");
  assert.equal(htmlPreserveCommentsAdapter.importedRoot, "playground/html");
});

test("the corpus test command selects the extension testName", () => {
  const manifest = readCorpusManifest();
  const entry = asRecord((asRecord(manifest)["entries"] as unknown[])[0]!);
  const argv = asRecord(asRecord(entry["commands"])["test"])["argv"];
  assert.ok(Array.isArray(argv));
  const command = argv.map((part) => {
    assert.equal(typeof part, "string");
    return part as string;
  });

  const testName = htmlPreserveCommentsAdapter.testName;
  assert.equal(testName, "main > preserve comments");
  const patternFlag = command.indexOf("--testNamePattern");
  assert.ok(patternFlag >= 0, "the Vite test-serve command must pass --testNamePattern");
  assert.equal(command[patternFlag + 1], testName);
  assert.equal(command[0], "pnpm");
  assert.equal(command[1], "test-serve");
  assert.ok(command.includes(htmlPreserveCommentsAdapter.importedRoot));
});
