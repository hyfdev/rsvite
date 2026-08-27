import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContractValidators } from "@rsvite/compatibility-contract";
import { test } from "vite-plus/test";
import {
  createElkManifest,
  declaredElkRun,
  ELK_COMMIT,
  ELK_ENTRY_ID,
  ELK_HOME_PATH,
  ELK_LICENSE_PATH,
  ELK_LOCKFILE,
  ELK_PNPM_VERSION,
  ELK_REPOSITORY,
  elkEntryFromManifest,
  elkEvidenceResultPaths,
  elkLicensePath,
  readCorpusManifest,
  type ElkSubject,
} from "../src/index.ts";

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function readResult(path: string): Record<string, unknown> {
  return asRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function assertResultArtifactsExist(path: string, result: Record<string, unknown>): void {
  const artifacts = result["artifactPaths"];
  assert.ok(Array.isArray(artifacts), `${path} has no artifactPaths array`);
  for (const artifact of artifacts) {
    assert.equal(typeof artifact, "string");
    assert.ok(artifact.length > 0);
    assert.equal(isAbsolute(artifact), false);
    assert.equal(artifact.split(/[\\/]/).includes(".."), false);
    assert.equal(statSync(join(dirname(path), artifact)).isFile(), true);
  }
}

test("the committed ELK entry pins the source, lockfile, mocked dev, and full build", () => {
  const corpusManifest = readCorpusManifest();
  const corpusCheck = createContractValidators().validateCorpusManifest(corpusManifest);
  assert.equal(
    corpusCheck.valid,
    true,
    corpusCheck.valid ? "" : JSON.stringify(corpusCheck.violations),
  );

  const committed = elkEntryFromManifest(corpusManifest);
  assert.equal(committed["id"], ELK_ENTRY_ID);
  assert.equal(committed["kind"], "real-project");
  assert.equal(asRecord(committed["source"])["repository"], ELK_REPOSITORY);
  assert.equal(asRecord(committed["source"])["commit"], ELK_COMMIT);
  assert.equal(asRecord(asRecord(committed["source"])["license"])["path"], ELK_LICENSE_PATH);
  assert.equal(asRecord(committed["lockfile"])["path"], ELK_LOCKFILE);
  assert.deepEqual(asRecord(asRecord(committed["lockfile"])["packageManager"]), {
    name: "pnpm",
    version: ELK_PNPM_VERSION,
  });
  assert.deepEqual(asRecord(asRecord(committed["commands"])["install"])["argv"], [
    "pnpm",
    "install",
    "--frozen-lockfile",
  ]);
  assert.deepEqual(asRecord(asRecord(committed["commands"])["dev"])["argv"], [
    "pnpm",
    "dev:mocked",
  ]);
  assert.deepEqual(asRecord(asRecord(committed["commands"])["build"])["argv"], ["pnpm", "build"]);
  assert.deepEqual(asRecord(asRecord(committed["commands"])["preview"])["argv"], ["pnpm", "start"]);
  assert.equal(asRecord(committed["browserAcceptance"])["entryPath"], ELK_HOME_PATH);
  assert.equal(committed["javascriptApiLevel"], "C3");

  const license = readFileSync(elkLicensePath);
  assert.equal(
    createHash("sha256").update(license).digest("hex"),
    "b8d01b64387167c9f878b7b7aaa15d35870ed89c0752be55ec3c76de6c1362c4",
  );
  assert.match(license.toString("utf8"), /MIT License/);
});

test("a cloned run manifest still validates after binding a free port", () => {
  const manifest = createElkManifest({
    lifecycle: "dev",
    pnpmVersion: ELK_PNPM_VERSION,
    port: 5314,
    subject: "vite",
  });
  const check = createContractValidators().validateCorpusManifest(manifest);
  assert.equal(check.valid, true, check.valid ? "" : JSON.stringify(check.violations));
  const entry = elkEntryFromManifest(manifest);
  const argv = asRecord(asRecord(entry["commands"])["dev"])["argv"];
  assert.ok(Array.isArray(argv));
  assert.equal(argv[0], "pnpm");
  assert.ok(argv.includes("nuxt"));
  assert.ok(argv.includes(".env.mock"));
  assert.ok(argv.includes("5314"));
});

test("rsvite records the ELK gap as C0 Rust ownership without a Vite fallback", () => {
  const declared = declaredElkRun("rsvite", "dev");
  assert.equal(declared.javascriptApiLevel, "C0");
  assert.equal(declared.explicitFallbacks.length, 0);
  assert.ok(declared.capabilityOwners.every((owner) => owner.owner === "rust"));
  const classified = declared.classifyFailure({
    phase: "dev",
    message: "rsvite could not start",
  });
  assert.equal(classified?.kind, "current-compatibility-requirement");
  assert.match(classified?.evidence ?? "", /rsvite failed during dev/);
});

test("removing the ELK pin from the corpus fails the canonical validator", () => {
  const manifest = structuredClone(readCorpusManifest()) as { entries: Record<string, unknown>[] };
  const entry = manifest.entries.find((candidate) => candidate["id"] === ELK_ENTRY_ID);
  assert.ok(entry);
  entry["source"] = { ...asRecord(entry["source"]), commit: "not-a-commit" };
  const check = createContractValidators().validateCorpusManifest(manifest);
  assert.equal(check.valid, false);
});

const committedEvidence: {
  path: string;
  lifecycle: "dev" | "build" | "preview";
  subject: ElkSubject;
  outcome: "pass" | "fail";
}[] = [
  {
    path: elkEvidenceResultPaths.vite.dev,
    lifecycle: "dev",
    subject: "vite",
    outcome: "pass",
  },
  {
    path: elkEvidenceResultPaths.vite.build,
    lifecycle: "build",
    subject: "vite",
    outcome: "pass",
  },
  {
    path: elkEvidenceResultPaths.vite.preview,
    lifecycle: "preview",
    subject: "vite",
    outcome: "pass",
  },
  {
    path: elkEvidenceResultPaths.rsvite.dev,
    lifecycle: "dev",
    subject: "rsvite",
    outcome: "fail",
  },
];

test("the committed ELK raw results preserve the Vite baseline and first rsvite gap", () => {
  const validators = createContractValidators();

  for (const evidence of committedEvidence) {
    assert.equal(existsSync(evidence.path), true, `${evidence.path} is missing`);
    const result = readResult(evidence.path);
    assertResultArtifactsExist(evidence.path, result);
    assert.equal(result["outcome"], evidence.outcome);
    assert.equal(asRecord(result["subject"])["name"], evidence.subject);
    assert.deepEqual(result["manifestEntry"], {
      id: ELK_ENTRY_ID,
      sourceCommit: ELK_COMMIT,
    });
    const packageManager = asRecord(asRecord(result["environment"])["packageManager"]);
    assert.equal(packageManager["name"], "pnpm");
    assert.equal(packageManager["version"], ELK_PNPM_VERSION);
    const runManifest = createElkManifest({
      lifecycle: evidence.lifecycle,
      pnpmVersion: ELK_PNPM_VERSION,
      port: 5314,
      subject: evidence.subject,
    });
    const pair = validators.validateResultAgainstManifest(runManifest, result);
    assert.equal(pair.valid, true, pair.valid ? "" : JSON.stringify(pair.violations));
  }

  const rsvite = readResult(elkEvidenceResultPaths.rsvite.dev);
  assert.equal(rsvite["javascriptApiLevel"], "C0");
  assert.ok(asRecord(rsvite["firstIncompatibleBehavior"]));
  assert.equal(
    asRecord(rsvite["failureClassification"])["kind"],
    "current-compatibility-requirement",
  );
});

test("the record task forwards ELK_CHECKOUT and RUNNER_IMAGE through Vite+", () => {
  const config = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../vite.config.ts"),
    "utf8",
  );
  assert.match(config, /"record:elk:baseline"/);
  assert.match(config, /env:\s*\[\s*"ELK_CHECKOUT",\s*"RUNNER_IMAGE"\s*\]/);
});
