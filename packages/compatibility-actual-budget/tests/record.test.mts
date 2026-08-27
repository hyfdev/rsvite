import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import type { Pin } from "../src/index.ts";
import { assertPinnedInputs } from "../src/translations.ts";
import { record, type RecordRequest } from "../src/record.ts";
import { pinnedCheckout, recordingCheck } from "./support.mts";

function evidenceRoots(): { publishRoot: string; stagingRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), "ab-evidence-"));
  return { publishRoot: join(dir, "published"), stagingRoot: join(dir, "staging") };
}

function publishEarlier(publishRoot: string, body: string): void {
  mkdirSync(publishRoot, { recursive: true });
  writeFileSync(join(publishRoot, "result.json"), body);
}

function request(
  checkout: { root: string; pin: Pin },
  overrides: Partial<RecordRequest> = {},
): RecordRequest {
  return {
    checkoutRoot: checkout.root,
    manifest: { entries: [{ id: "actual-budget" }] },
    entryId: "actual-budget",
    lifecycle: "dev" as const,
    subject: { name: "vite" as const, version: "8.1.5" },
    environment: {
      os: "linux",
      arch: "x64",
      runnerImage: "local",
      nodeVersion: "24",
      packageManager: { name: "yarn", version: "4.17.1" },
    },
    declared: {
      javascriptApiLevel: "C0" as const,
      capabilityOwners: [],
      explicitFallbacks: [],
      classifyFailure: () => undefined,
    },
    timeouts: { installMs: 1_000, lifecycleMs: 1_000, browserMs: 1_000 },
    verifyInputs: () => {
      assertPinnedInputs(checkout.root, checkout.pin);
    },
    ...evidenceRoots(),
    ...overrides,
  };
}

test("inputs that are not the pinned ones are refused before anything runs", async () => {
  const checkout = pinnedCheckout();
  const check = recordingCheck("pass");
  const asked = request(
    { root: checkout.root, pin: { ...checkout.pin, commit: "0".repeat(40) } },
    { check: check.check },
  );

  await assert.rejects(record(asked), /the corpus pins 0{40}/);
  assert.equal(check.calls(), 0, "a command ran against a checkout that was not the pinned one");
});

test("an input the build reads outside the checkout's history is refused too", async () => {
  const checkout = pinnedCheckout();
  const check = recordingCheck("pass");
  // The outer checkout is untouched and reads clean; only the ignored nested input has moved.
  rmSync(join(checkout.root, checkout.pin.translations.path), { recursive: true });
  const asked = request(checkout, { check: check.check });

  await assert.rejects(record(asked), /would clone a moving one/);
  assert.equal(check.calls(), 0);
});

test("a run that dirtied the checkout publishes nothing and leaves earlier evidence intact", async () => {
  const checkout = pinnedCheckout();
  const check = recordingCheck("pass");
  const asked = request(checkout, {
    check: async (runRequest) => {
      // What an upstream command does: it leaves something behind that the pin does not describe.
      writeFileSync(join(checkout.root, "stray.txt"), "x");
      return check.check(runRequest);
    },
  });
  publishEarlier(asked.publishRoot, `{"outcome":"the earlier recording"}`);

  await assert.rejects(record(asked), /the checkout has local changes/);
  assert.equal(check.calls(), 1, "the check never ran, so nothing was verified afterwards");
  assert.equal(
    readFileSync(join(asked.publishRoot, "result.json"), "utf8"),
    `{"outcome":"the earlier recording"}`,
    "a run whose inputs stopped being the pinned ones replaced the published evidence",
  );
});

test("a recorded failure is published, because a subject that cannot run is a finding", async () => {
  const checkout = pinnedCheckout();
  const asked = request(checkout, { check: recordingCheck("fail").check });

  const recording = await record(asked);

  assert.equal(recording.failure?.phase, "dev");
  assert.equal(recording.resultPath, join(asked.publishRoot, "result.json"));
  assert.equal(
    (JSON.parse(readFileSync(recording.resultPath, "utf8")) as { outcome: string }).outcome,
    "fail",
  );
});

test("whatever the run edited is undone before the inputs are verified", async () => {
  const checkout = pinnedCheckout();
  const editPath = join(checkout.root, checkout.pin.sentinelEditPath);
  const original = readFileSync(editPath, "utf8");
  const check = recordingCheck("pass");
  const asked = request(checkout, {
    check: async (runRequest) => {
      writeFileSync(editPath, "edited\n");
      return check.check(runRequest);
    },
    restore: () => {
      writeFileSync(editPath, original);
      return Promise.resolve();
    },
  });

  await record(asked);

  assert.equal(readFileSync(editPath, "utf8"), original);
  assert.equal(existsSync(join(asked.publishRoot, "result.json")), true);
});

test("a recording that failed leaves no staging directory for a later one to inherit", async () => {
  const checkout = pinnedCheckout();
  const asked = request(checkout, {
    check: () => Promise.reject(new Error("the runner gave up")),
  });

  await assert.rejects(record(asked), /the runner gave up/);
  assert.equal(existsSync(asked.stagingRoot), false);
});
