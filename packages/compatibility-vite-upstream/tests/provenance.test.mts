import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assertCleanGitWorktree,
  assertLinuxX64Host,
  assertPinnedCleanViteCheckout,
  assertPnpmVersion,
  assertResultArtifactsExist,
  corepackCachedPnpmCjs,
  ensureManifestPnpmOnPath,
  htmlPreserveCommentsAdapter,
  htmlPreserveCommentsCommandExecutable,
  htmlPreserveCommentsPackageManager,
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
  assert.equal(asRecord(result["environment"])["os"], "linux");
  assert.equal(asRecord(result["environment"])["arch"], "x64");
  assert.equal(asRecord(asRecord(result["environment"])["packageManager"])["name"], "pnpm");
  assert.equal(asRecord(asRecord(result["environment"])["packageManager"])["version"], "10.34.5");
  assertResultArtifactsExist(viteBaselineResultPath, result);
});

test("a committed result that names missing evidence is rejected", () => {
  const result = JSON.parse(readFileSync(viteBaselineResultPath, "utf8")) as Record<
    string,
    unknown
  >;
  const missing = { ...result, artifactPaths: ["does-not-exist.log"] };
  assert.throws(
    () => assertResultArtifactsExist(viteBaselineResultPath, missing),
    /missing evidence does-not-exist\.log/,
  );
});

test("the record task passes VITE_CHECKOUT and RUNNER_IMAGE through Vite+", () => {
  const config = readFileSync(join(testsDir, "../../../vite.config.ts"), "utf8");
  assert.match(config, /"record:vite-upstream:baseline"/);
  assert.match(config, /env:\s*\[\s*"VITE_CHECKOUT",\s*"RUNNER_IMAGE"\s*\]/);
});

function initTempGitRepo(): string {
  const dir = mkdtempSync(join("/tmp", "rsvite-git-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  writeFileSync(join(dir, "tracked.txt"), "ok\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

test("a checkout with staged, unstaged, or untracked changes is not recorded as the pin", () => {
  const dir = initTempGitRepo();
  try {
    assertCleanGitWorktree(dir);

    writeFileSync(join(dir, "untracked.txt"), "x\n");
    assert.throws(() => assertCleanGitWorktree(dir), /not clean/);
    rmSync(join(dir, "untracked.txt"));
    assertCleanGitWorktree(dir);

    writeFileSync(join(dir, "tracked.txt"), "dirty\n");
    assert.throws(() => assertCleanGitWorktree(dir), /not clean/);
    execFileSync("git", ["checkout", "--", "tracked.txt"], { cwd: dir });
    assertCleanGitWorktree(dir);

    writeFileSync(join(dir, "tracked.txt"), "staged\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    assert.throws(() => assertCleanGitWorktree(dir), /not clean/);

    assert.throws(() => assertPinnedCleanViteCheckout(dir), /HEAD is/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a host that is not Linux x64 is not recorded as the baseline environment", () => {
  assert.throws(() => assertLinuxX64Host("darwin", "x64"), /darwin\/x64/);
  assert.throws(() => assertLinuxX64Host("linux", "arm64"), /linux\/arm64/);
  assert.deepEqual(assertLinuxX64Host("linux", "x64"), { os: "linux", arch: "x64" });
});

test("a pnpm that is not the lockfile version is not recorded as that version", () => {
  const dir = mkdtempSync(join("/tmp", "rsvite-pnpm-"));
  const other = mkdtempSync(join("/tmp", "rsvite-pnpm-"));
  const fake = join(dir, "pnpm");
  const expected = htmlPreserveCommentsPackageManager().version;
  try {
    writeFileSync(
      fake,
      `#!${process.execPath}
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
process.stdout.write(readFileSync(join(process.cwd(), "version.txt"), "utf8"));
`,
    );
    chmodSync(fake, 0o755);
    writeFileSync(join(dir, "version.txt"), "9.15.0\n");
    writeFileSync(join(other, "version.txt"), `${expected}\n`);
    assert.throws(() => assertPnpmVersion(fake, expected, { cwd: dir }), /9\.15\.0/);
    assert.equal(assertPnpmVersion(fake, expected, { cwd: other }), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("manifest install and test commands start with the lockfile package manager", () => {
  const packageManager = htmlPreserveCommentsPackageManager();
  assert.equal(packageManager.name, "pnpm");
  assert.equal(packageManager.version, "10.34.5");
  assert.equal(htmlPreserveCommentsCommandExecutable("install"), "pnpm");
  assert.equal(htmlPreserveCommentsCommandExecutable("test"), "pnpm");
});

test("the lockfile pnpm can be spawned while the parent session is another pnpm", () => {
  const expected = htmlPreserveCommentsPackageManager().version;
  const previousPath = process.env["PATH"];
  try {
    execFileSync("corepack", ["install", "-g", `pnpm@${expected}`, "--cache-only"], {
      encoding: "utf8",
    });
    assert.equal(existsSync(corepackCachedPnpmCjs(expected)), true);
    ensureManifestPnpmOnPath(expected);
    assert.equal(assertPnpmVersion("pnpm", expected), expected);
  } finally {
    process.env["PATH"] = previousPath;
  }
});
