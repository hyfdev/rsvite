import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, test } from "vite-plus/test";
import {
  assertRsviteResultSubjectIsCurrent,
  readRsviteWorkspaceSubject,
  resolveRsviteSourceOwner,
} from "../src/index.ts";
import { cleanUpFixtures, workspaceFixture } from "./support.mts";

afterAll(cleanUpFixtures);

test("the owner is what protected main says owns the product source", () => {
  const workspace = workspaceFixture();

  assert.equal(resolveRsviteSourceOwner(workspace.root), workspace.owner);
  assert.deepEqual(readRsviteWorkspaceSubject(workspace.root), {
    name: "rsvite",
    version: "0.0.0",
    commit: workspace.owner,
  });
});

test("a commit that changes only the recording environment does not become the owner", () => {
  const workspace = workspaceFixture();
  // What Issue #25 does: root test orchestration, on protected main.
  workspace.write("vite.config.ts", "export default { changed: true };\n");
  workspace.commit("chore: change root test orchestration");
  workspace.publish();

  assert.equal(
    resolveRsviteSourceOwner(workspace.root),
    workspace.owner,
    "a change outside the product source moved the recorded product identity",
  );
});

test("a topic branch that only touches the environment keeps the protected owner", () => {
  const workspace = workspaceFixture();
  workspace.git("checkout", "--quiet", "-b", "topic");
  workspace.write("vite.config.ts", "export default { topic: true };\n");
  workspace.commit("chore: topic-only orchestration change");

  assert.equal(resolveRsviteSourceOwner(workspace.root), workspace.owner);
});

test("a topic branch that changes the product source is refused", () => {
  const workspace = workspaceFixture();
  workspace.git("checkout", "--quiet", "-b", "topic");
  workspace.write("crates/rsvite_core/src/lib.rs", "pub fn serve() { /* changed */ }\n");
  const topic = workspace.commit("feat: change the product on a branch");

  assert.throws(
    () => resolveRsviteSourceOwner(workspace.root),
    new RegExp(`owner is ${topic}, but protected main's is ${workspace.owner}`),
    "a product-changing topic commit was accepted as the durable source owner",
  );
});

test("a branch left behind protected main's product source is refused", () => {
  const workspace = workspaceFixture();
  workspace.git("checkout", "--quiet", "-b", "stale");
  workspace.git("checkout", "--quiet", "main");
  workspace.write("crates/rsvite_core/src/lib.rs", "pub fn serve() { /* newer */ }\n");
  const newer = workspace.commit("feat: advance the product on main");
  workspace.publish();
  workspace.git("checkout", "--quiet", "stale");

  assert.throws(
    () => resolveRsviteSourceOwner(workspace.root),
    new RegExp(`owner is ${workspace.owner}, but protected main's is ${newer}`),
    "a stale branch was accepted while protected main had newer product source",
  );
});

test("uncommitted product source is refused, including a file git is not tracking", () => {
  const workspace = workspaceFixture();
  writeFileSync(join(workspace.root, "crates/rsvite_core/src/extra.rs"), "// untracked\n");

  assert.throws(
    () => resolveRsviteSourceOwner(workspace.root),
    /must be committed before recording/,
  );
});

test("a result stays current while only the recording environment moved", () => {
  const workspace = workspaceFixture();
  const subject = readRsviteWorkspaceSubject(workspace.root);
  workspace.write("vite.config.ts", "export default { changed: true };\n");
  workspace.commit("chore: change root test orchestration");
  workspace.publish();

  assert.doesNotThrow(() => {
    assertRsviteResultSubjectIsCurrent(subject, workspace.root);
  });
});

test("a result goes stale when protected main owns a different product source", () => {
  const workspace = workspaceFixture();
  const subject = readRsviteWorkspaceSubject(workspace.root);
  workspace.write("crates/rsvite_core/src/lib.rs", "pub fn serve() { /* newer */ }\n");
  const newer = workspace.commit("feat: advance the product");
  workspace.publish();

  assert.throws(
    () => {
      assertRsviteResultSubjectIsCurrent(subject, workspace.root);
    },
    new RegExp(`must record the current product source ${newer}`),
    "a result describing an older product was still treated as current",
  );
});

test("a result naming some other commit is refused even when that commit exists", () => {
  const workspace = workspaceFixture();
  const subject = readRsviteWorkspaceSubject(workspace.root);
  workspace.write("vite.config.ts", "export default { unrelated: true };\n");
  const unrelated = workspace.commit("chore: an unrelated commit");
  workspace.publish();

  assert.throws(
    () => {
      assertRsviteResultSubjectIsCurrent({ ...subject, commit: unrelated }, workspace.root);
    },
    new RegExp(`must record the current product source ${workspace.owner}`),
  );
});

test("metadata that is unreadable or declares no version is refused", () => {
  const malformed = workspaceFixture();
  malformed.write("packages/rsvite/package.json", "{ not json\n");
  malformed.commit("chore: break the metadata");
  malformed.publish();
  assert.throws(() => readRsviteWorkspaceSubject(malformed.root), /is not valid JSON/);

  const versionless = workspaceFixture();
  versionless.write(
    "packages/rsvite/package.json",
    `${JSON.stringify({ name: "rsvite", version: "", bin: { rsvite: "./bin/rsvite.js" } }, null, 2)}\n`,
  );
  versionless.commit("chore: empty the version");
  versionless.publish();
  assert.throws(
    () => readRsviteWorkspaceSubject(versionless.root),
    /must declare a non-empty string version/,
  );
});

test("metadata is read from the matched source, and a bad name or version is refused", () => {
  const workspace = workspaceFixture("1.2.3");
  assert.equal(readRsviteWorkspaceSubject(workspace.root).version, "1.2.3");

  const renamed = workspaceFixture();
  renamed.write(
    "packages/rsvite/package.json",
    `${JSON.stringify({ name: "not-rsvite", version: "0.0.0", bin: { rsvite: "./bin/rsvite.js" } }, null, 2)}\n`,
  );
  renamed.commit("chore: rename the package");
  renamed.publish();

  assert.throws(
    () => readRsviteWorkspaceSubject(renamed.root),
    /must declare the package name rsvite/,
  );
});

test("a checkout that cannot see protected main says so, instead of guessing", () => {
  const workspace = workspaceFixture();
  workspace.git("update-ref", "-d", "refs/remotes/origin/main");

  assert.throws(
    () => resolveRsviteSourceOwner(workspace.root),
    /has no refs\/remotes\/origin\/main/,
    "a checkout without protected main resolved an owner anyway",
  );
});

test("a hidden index flag cannot make an edited product source look pristine", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"] as const) {
    const workspace = workspaceFixture();
    const tracked = "crates/rsvite_core/src/lib.rs";
    workspace.git("update-index", flag, tracked);
    writeFileSync(join(workspace.root, tracked), "pub fn serve() { /* edited in secret */ }\n");

    // Both of git's own answers are now wrong about this file.
    assert.equal(workspace.git("status", "--porcelain=v1", "--", tracked), "");
    assert.equal(workspace.git("diff", "--name-only", "--", tracked), "");

    assert.throws(
      () => resolveRsviteSourceOwner(workspace.root),
      /assume-unchanged or skip-worktree/,
      `${flag} let an edited product source resolve as the protected owner`,
    );
  }
});

test("a product source file whose executable bit changed is not the owner's", () => {
  const workspace = workspaceFixture();
  chmodSync(join(workspace.root, "packages/rsvite/bin/rsvite.js"), 0o644);

  assert.throws(
    () => resolveRsviteSourceOwner(workspace.root),
    /different mode from .* at packages\/rsvite\/bin\/rsvite\.js/,
  );
});
