import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createContractValidators } from "@rsvite/compatibility-contract";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  viteBaselineResultPath,
  vitestTestNamePattern,
} from "../src/index.ts";

const require = createRequire(import.meta.url);
const testsDir = dirname(fileURLToPath(import.meta.url));

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

function corpusTestCommand(): string[] {
  const manifest = readCorpusManifest();
  const entry = asRecord((asRecord(manifest)["entries"] as unknown[])[0]!);
  const argv = asRecord(asRecord(entry["commands"])["test"])["argv"];
  assert.ok(Array.isArray(argv));
  return argv.map((part) => {
    assert.equal(typeof part, "string");
    return part as string;
  });
}

test("the corpus test command selects the extension testName", () => {
  const command = corpusTestCommand();
  const testName = htmlPreserveCommentsAdapter.testName;
  assert.equal(testName, "main > preserve comments");
  const patternFlag = command.indexOf("--testNamePattern");
  assert.ok(patternFlag >= 0, "the Vite test-serve command must pass --testNamePattern");
  assert.equal(command[patternFlag + 1], vitestTestNamePattern(testName));
  assert.equal(command[0], "pnpm");
  assert.equal(command[1], "test-serve");
  assert.ok(command.includes(htmlPreserveCommentsAdapter.importedRoot));
  assert.ok(
    !command.includes("--"),
    "a lone -- makes Vitest treat the filter as a positional path",
  );
});

test("Vitest 4.1.11 selects only the full test name when the corpus argv has no lone --", () => {
  const command = corpusTestCommand();
  const testName = htmlPreserveCommentsAdapter.testName;
  const fixtureDir = join(testsDir, "fixtures");
  const vitestArgs = command
    .slice(command.indexOf("test-serve") + 1)
    .map((part) =>
      part === htmlPreserveCommentsAdapter.importedRoot ? "html-filter-probe.spec.ts" : part,
    );

  const vitestPkgPath = require.resolve("vitest/package.json");
  const vitestPkg = JSON.parse(readFileSync(vitestPkgPath, "utf8")) as {
    version: string;
    bin?: string | { vitest?: string };
  };
  assert.equal(vitestPkg.version, "4.1.11");
  const vitestRoot = dirname(vitestPkgPath);
  const binRel =
    typeof vitestPkg.bin === "string" ? vitestPkg.bin : (vitestPkg.bin?.vitest ?? "vitest.mjs");
  const vitestBin = join(vitestRoot, binRel);

  const probe = spawnSync(
    process.execPath,
    [vitestBin, "run", "--config", join(fixtureDir, "vitest.config.ts"), ...vitestArgs],
    {
      encoding: "utf8",
      cwd: fixtureDir,
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  const output = `${probe.stdout}\n${probe.stderr}`;
  assert.equal(probe.status, 0, `focused Vitest command failed:\n${output}`);
  assert.match(output, /1 passed/);
  assert.match(output, /1 skipped/);
  assert.equal(command[command.indexOf("--testNamePattern") + 1], vitestTestNamePattern(testName));
});

test("the committed Vite baseline is accepted with the corpus manifest", () => {
  assert.equal(existsSync(viteBaselineResultPath), true, "the Vite baseline result is missing");
  const result = JSON.parse(readFileSync(viteBaselineResultPath, "utf8")) as Record<
    string,
    unknown
  >;
  const check = createContractValidators().validateResultAgainstManifest(
    readCorpusManifest(),
    result,
  );
  assert.deepEqual(
    check.valid ? [] : check.violations,
    [],
    check.valid ? "" : check.violations.map((v) => v.message).join("\n"),
  );
  assert.equal(result["outcome"], "pass");
  assert.equal(asRecord(result["subject"])["name"], "vite");
  assert.equal(asRecord(result["manifestEntry"])["id"], HTML_PRESERVE_COMMENTS_ENTRY_ID);
  assert.equal(asRecord(result["manifestEntry"])["sourceCommit"], VITE_UPSTREAM_COMMIT);
  assert.deepEqual(result["explicitFallbacks"], []);
});
