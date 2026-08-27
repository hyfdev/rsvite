import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import {
  assertDrawDbResultArtifactsExist,
  drawDbEvidenceRoot,
  recordDrawDbEvidence,
} from "../src/index.ts";

await rm(drawDbEvidenceRoot, { force: true, recursive: true });
await mkdir(drawDbEvidenceRoot, { recursive: true });

const reports = await recordDrawDbEvidence({ artifactRoot: drawDbEvidenceRoot });
for (const report of [reports.dev, reports.build, reports.preview]) {
  const result = report.result as { outcome: string };
  assert.equal(result.outcome, "pass", report.failure?.message);
  assert.equal(report.failure, undefined);
  assertDrawDbResultArtifactsExist(report.resultPath, report.result);
}

const rsviteResult = reports.rsvite.result as {
  outcome: string;
  javascriptApiLevel: string;
  firstIncompatibleBehavior?: { phase: string };
  capabilityOwners: Array<{ owner: string }>;
};
assert.equal(rsviteResult.outcome, "fail");
assert.equal(rsviteResult.javascriptApiLevel, "C0");
assert.equal(rsviteResult.firstIncompatibleBehavior?.phase, "dev");
assert.ok(rsviteResult.capabilityOwners.every((owner) => owner.owner === "rust"));
assertDrawDbResultArtifactsExist(reports.rsvite.resultPath, reports.rsvite.result);

process.stdout.write(`${drawDbEvidenceRoot}\n`);
