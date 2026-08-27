import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
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

function request(overrides: Partial<RecordRequest> & Pick<RecordRequest, "checkoutRoot" | "pin">) {
  const roots = evidenceRoots();
  return {
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
    ...roots,
    ...overrides,
  };
}

test("a build that fails cannot leave a result behind it", async () => {
  const checkout = pinnedCheckout();
  const check = recordingCheck("pass");
  const asked = request({ checkoutRoot: checkout.root, pin: checkout.pin, check: check.check });
  publishEarlier(asked.publishRoot, `{"outcome":"the earlier recording"}`);

  await assert.rejects(
    record({
      ...asked,
      preconditions: [
        {
          label: "the project's own browser build",
          command: { argv: [process.execPath, "-e", "process.exit(1)"], cwd: checkout.root },
          timeoutMs: 60_000,
        },
      ],
    }),
    /the project's own browser build exited with code 1/,
  );

  assert.equal(check.calls(), 0, "the check ran even though the build it depends on had failed");
  assert.equal(
    readFileSync(join(asked.publishRoot, "result.json"), "utf8"),
    `{"outcome":"the earlier recording"}`,
    "a failed build replaced the published evidence",
  );
});

test("a checkout an upstream command dirtied publishes nothing", async () => {
  const checkout = pinnedCheckout();
  const check = recordingCheck("pass");
  const asked = request({ checkoutRoot: checkout.root, pin: checkout.pin, check: check.check });

  await assert.rejects(
    record({
      ...asked,
      preconditions: [
        {
          label: "the project's own browser build",
          // A build that leaves something behind: the run is no longer about the pinned input.
          command: {
            argv: [process.execPath, "-e", `require("node:fs").writeFileSync("stray.txt", "x")`],
            cwd: checkout.root,
          },
          timeoutMs: 60_000,
        },
      ],
    }),
    /the checkout has local changes/,
  );

  assert.equal(check.calls(), 1, "the check never ran, so nothing was being verified afterwards");
  assert.equal(
    existsSync(join(asked.publishRoot, "result.json")),
    false,
    "a result was published from a checkout that was no longer the pinned one",
  );
});

test("a recorded failure is published, because a subject that cannot run is a finding", async () => {
  const checkout = pinnedCheckout();
  const asked = request({
    checkoutRoot: checkout.root,
    pin: checkout.pin,
    check: recordingCheck("fail").check,
  });

  const recording = await record(asked);

  assert.equal(recording.failure?.phase, "dev");
  assert.equal(recording.resultPath, join(asked.publishRoot, "result.json"));
  assert.equal(JSON.parse(readFileSync(recording.resultPath, "utf8")).outcome, "fail");
});

test("whatever the run edited is undone before the checkout is verified", async () => {
  const checkout = pinnedCheckout();
  const editPath = join(checkout.root, checkout.pin.sentinelEditPath);
  const original = readFileSync(editPath, "utf8");
  const asked = request({
    checkoutRoot: checkout.root,
    pin: checkout.pin,
    check: recordingCheck("pass").check,
  });

  await record({
    ...asked,
    preconditions: [
      {
        label: "an edit the run makes",
        command: {
          argv: [
            process.execPath,
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(editPath)}, "edited\\n")`,
          ],
          cwd: checkout.root,
        },
        timeoutMs: 60_000,
      },
    ],
    restore: async () => {
      writeFileSync(editPath, original);
      return Promise.resolve();
    },
  });

  assert.equal(readFileSync(editPath, "utf8"), original);
});

test("a checkout that is not the pinned one is refused before anything runs", async () => {
  const checkout = pinnedCheckout();
  const check = recordingCheck("pass");
  const asked = request({
    checkoutRoot: checkout.root,
    pin: { ...checkout.pin, commit: "0".repeat(40) },
    check: check.check,
  });

  await assert.rejects(record(asked), /the corpus pins 0{40}/);
  assert.equal(check.calls(), 0);
});
