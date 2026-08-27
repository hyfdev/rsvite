import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { runUpstream } from "../src/upstream.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "ab-upstream-"));
}

test("a command that outlives its budget is stopped, and never gets to finish", async () => {
  const dir = scratch();
  const marker = join(dir, "finished");
  const run = await runUpstream({
    label: "the project's own onboarding spec",
    // Far past the budget: if the step is not stopped, the marker is what appears instead.
    command: {
      argv: [
        process.execPath,
        "-e",
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done"), 5000)`,
      ],
      cwd: dir,
    },
    timeoutMs: 250,
  });

  assert.equal(run.end, "timed-out");
  assert.equal(
    run.problem,
    "the project's own onboarding spec did not finish within 250ms",
    "a step that ran past its budget was not reported as having run out of time",
  );
  assert.ok(run.outcome.timedOut);
  assert.equal(existsSync(marker), false, "the abandoned command was left running to completion");
});

test("a command the caller gives up on is reported as abandoned, not as a timeout", async () => {
  const dir = scratch();
  const controller = new AbortController();
  const run = runUpstream(
    {
      label: "the project's own browser build",
      command: { argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], cwd: dir },
      // Far beyond the test, so only the caller giving up can end it.
      timeoutMs: 600_000,
    },
    controller.signal,
  );
  controller.abort(new Error("the recorder gave up"));

  const settled = await run;
  assert.equal(settled.end, "abandoned");
  assert.equal(settled.problem, "the project's own browser build was abandoned before it finished");
  assert.equal(settled.outcome.timedOut, false, "giving up was recorded as the budget expiring");
});

test("a command that fails is reported with the code it exited with", async () => {
  const run = await runUpstream({
    label: "the project's own browser build",
    command: { argv: [process.execPath, "-e", "process.exit(3)"], cwd: scratch() },
    timeoutMs: 60_000,
  });

  assert.equal(run.end, "exited");
  assert.equal(run.problem, "the project's own browser build exited with code 3");
});

test("a command that does not exist is reported as never having started", async () => {
  const run = await runUpstream({
    label: "the project's own browser build",
    command: { argv: [join(scratch(), "no-such-command"), "--build"], cwd: scratch() },
    timeoutMs: 60_000,
  });

  assert.match(run.problem ?? "", /^the project's own browser build could not start: /);
});

test("a command that finishes in time reports no problem", async () => {
  const run = await runUpstream({
    label: "the project's own browser build",
    command: { argv: [process.execPath, "-e", "process.exit(0)"], cwd: scratch() },
    timeoutMs: 60_000,
  });

  assert.equal(run.end, "exited");
  assert.equal(run.problem, undefined);
});
