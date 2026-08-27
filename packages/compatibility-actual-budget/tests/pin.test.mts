import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  actualBudgetCommands,
  inspectCheckout,
  readPin,
  upstreamE2eCommand,
} from "../src/index.ts";

function git(root: string, args: readonly string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

/** A throwaway checkout that stands in for the pinned project, so the rules can be exercised. */
async function fakeCheckout(pinnedCommit: boolean): Promise<string> {
  const pin = readPin();
  const root = mkdtempSync(join(tmpdir(), "ab-pin-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "probe@example.com"]);
  git(root, ["config", "user.name", "probe"]);
  await mkdir(join(root, "packages/desktop-client/e2e"), { recursive: true });
  writeFileSync(join(root, pin.license.path), "MIT");
  writeFileSync(join(root, pin.lockfile.path), "lock");
  writeFileSync(join(root, pin.e2eSpec), "test");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "pinned"]);
  void pinnedCommit;
  return root;
}

test("a checkout at the wrong commit cannot be used as evidence", async () => {
  const root = await fakeCheckout(false);

  const problems = inspectCheckout(root);

  assert.ok(
    problems.some((problem) => problem.kind === "wrong-commit"),
    "a checkout at another commit was accepted",
  );
});

test("a locally modified checkout cannot be used as evidence", async () => {
  const pin = readPin();
  const root = await fakeCheckout(false);
  // Even an untracked file changes what a build or a test can see.
  writeFileSync(join(root, "extra-file"), "local");

  const problems = inspectCheckout(root, { ...pin, commit: gitHead(root) });

  assert.ok(
    problems.some((problem) => problem.kind === "modified"),
    "a dirty checkout was accepted",
  );
});

test("a checkout missing the license, lockfile or upstream spec is rejected", async () => {
  const pin = readPin();
  const root = mkdtempSync(join(tmpdir(), "ab-empty-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "probe@example.com"]);
  git(root, ["config", "user.name", "probe"]);
  writeFileSync(join(root, "only-file"), "x");
  git(root, ["add", "-A"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["commit", "--quiet", "-m", "empty"]);

  const problems = inspectCheckout(root, { ...pin, commit: gitHead(root) });

  assert.deepEqual(
    problems.filter((problem) => problem.kind === "missing").map((problem) => problem.detail),
    [
      `${pin.license.path} is missing from the checkout`,
      `${pin.lockfile.path} is missing from the checkout`,
      `${pin.e2eSpec} is missing from the checkout`,
    ],
  );
});

test("the install command refuses to resolve anything the lockfile does not record", () => {
  const commands = actualBudgetCommands(3001);

  assert.deepEqual(commands["install"]?.argv, ["corepack", "yarn", "install", "--immutable"]);
});

test("the upstream spec runs against the runner's server instead of starting its own", () => {
  const command = upstreamE2eCommand("http://127.0.0.1:4321");

  assert.equal(command.env?.["E2E_START_URL"], "http://127.0.0.1:4321");
  // The spec path is the project's own file; nothing about it is rewritten.
  assert.ok(command.argv.includes("e2e/onboarding.test.ts"));
});

function gitHead(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
