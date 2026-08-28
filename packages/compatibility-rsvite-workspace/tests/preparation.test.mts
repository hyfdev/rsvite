import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vite-plus/test";
import {
  assertPreparedSubjectIsStillCurrent,
  hostNativeBinaryName,
  NATIVE_LIBRARY_OVERRIDE,
  prepareRsviteWorkspace,
} from "../src/index.ts";
import {
  cleanUpFixtures,
  trackTemporary,
  withSupportedBuild,
  workspaceFixture,
} from "./support.mts";

afterAll(cleanUpFixtures);

/** What a real native build leaves behind on this host. */
const OUTPUTS = `printf 'export class DevServer {}\\n' > packages/rsvite/native.js
printf '\\0binary\\n' > packages/rsvite/${hostNativeBinaryName()}`;

test("preparation runs the supported build and returns this checkout's own command", () => {
  const workspace = workspaceFixture();
  const build = withSupportedBuild(workspace.root, OUTPUTS);

  const prepared = prepareRsviteWorkspace(workspace.root);

  assert.equal(prepared.subject.commit, workspace.owner);
  assert.equal(prepared.executable, join(workspace.root, "packages/rsvite/bin/rsvite.js"));
  // The supported task, uncached — not a build the caller chose.
  assert.deepEqual(build.argv(), ["run", "--no-cache", "build:rsvite:native"]);
});

test("a same-named command on the host cannot stand in for the workspace command", () => {
  const workspace = workspaceFixture();
  withSupportedBuild(workspace.root, OUTPUTS);
  const hostBin = trackTemporary(mkdtempSync(join(tmpdir(), "rsvite-host-bin-")));
  const decoy = join(hostBin, "rsvite");
  writeFileSync(decoy, "#!/bin/sh\necho host\n");
  chmodSync(decoy, 0o755);
  const previousPath = process.env["PATH"];
  process.env["PATH"] = `${hostBin}:${previousPath ?? ""}`;

  try {
    assert.equal(
      prepareRsviteWorkspace(workspace.root).executable,
      join(workspace.root, "packages/rsvite/bin/rsvite.js"),
    );
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  }
});

test("identity is settled before the build runs", () => {
  const workspace = workspaceFixture();
  const build = withSupportedBuild(workspace.root, OUTPUTS);
  workspace.git("checkout", "--quiet", "-b", "topic");
  workspace.write("crates/rsvite_core/src/lib.rs", "pub fn serve() { /* changed */ }\n");
  workspace.commit("feat: change the product on a branch");

  assert.throws(() => prepareRsviteWorkspace(workspace.root), /but protected main's is/);
  assert.deepEqual(
    build.argv(),
    [],
    "the native build ran against a source this checkout could not name",
  );
});

test("a build that changes the product source is caught before its output is accepted", () => {
  const workspace = workspaceFixture();
  withSupportedBuild(
    workspace.root,
    `${OUTPUTS}\nprintf '// changed by the build\\n' > packages/rsvite/bin/rsvite.js`,
  );

  assert.throws(
    () => prepareRsviteWorkspace(workspace.root),
    /differs from .* at packages\/rsvite\/bin\/rsvite\.js/,
    "a build rewrote tracked product source and the preflight still accepted it",
  );
});

test("a failing native build is reported, and nothing is accepted after it", () => {
  const workspace = workspaceFixture();
  withSupportedBuild(workspace.root, `echo "cargo exited with code 101" >&2\nexit 101`);

  assert.throws(() => prepareRsviteWorkspace(workspace.root), /Command failed|exited/);
});

test("a directory cannot impersonate the loader or the platform binary", () => {
  const loader = workspaceFixture();
  withSupportedBuild(
    loader.root,
    `mkdir -p packages/rsvite/native.js\nprintf '\\0\\n' > packages/rsvite/${hostNativeBinaryName()}`,
  );
  assert.throws(
    () => prepareRsviteWorkspace(loader.root),
    /native\.js loader is not a regular file/,
  );

  const binary = workspaceFixture();
  withSupportedBuild(
    binary.root,
    `printf 'x\\n' > packages/rsvite/native.js\nmkdir -p packages/rsvite/${hostNativeBinaryName()}`,
  );
  assert.throws(() => prepareRsviteWorkspace(binary.root), /is not a regular file/);
});

test("a binary built for another platform is not accepted as this host's", () => {
  const workspace = workspaceFixture();
  withSupportedBuild(
    workspace.root,
    `printf 'x\\n' > packages/rsvite/native.js\nprintf '\\0\\n' > packages/rsvite/rsvite.aix-ppc64.node`,
  );

  assert.throws(
    () => prepareRsviteWorkspace(workspace.root),
    new RegExp(`produced no ${hostNativeBinaryName().replaceAll(".", "\\.")}`),
  );
});

test("a loader that links out to a host file is refused", () => {
  const outside = trackTemporary(mkdtempSync(join(tmpdir(), "rsvite-host-")));
  writeFileSync(join(outside, "native.js"), "export class DevServer {}\n");

  const workspace = workspaceFixture();
  withSupportedBuild(
    workspace.root,
    `ln -s ${JSON.stringify(join(outside, "native.js"))} packages/rsvite/native.js\nprintf '\\0\\n' > packages/rsvite/${hostNativeBinaryName()}`,
  );

  assert.throws(() => prepareRsviteWorkspace(workspace.root), /resolves outside packages\/rsvite/);
});

test("a committed command that links out to a host file is refused", () => {
  const outside = trackTemporary(mkdtempSync(join(tmpdir(), "rsvite-host-")));
  writeFileSync(join(outside, "rsvite.js"), "#!/usr/bin/env node\n");
  chmodSync(join(outside, "rsvite.js"), 0o755);

  // Committed, so the source check has nothing to object to: the escape is the repository's own
  // recorded state, and only the containment rule can catch it.
  const workspace = workspaceFixture();
  rmSync(join(workspace.root, "packages/rsvite/bin/rsvite.js"));
  symlinkSync(join(outside, "rsvite.js"), join(workspace.root, "packages/rsvite/bin/rsvite.js"));
  workspace.commit("chore: link the command out of the package");
  workspace.publish();
  withSupportedBuild(workspace.root, OUTPUTS);

  assert.throws(
    () => prepareRsviteWorkspace(workspace.root),
    /rsvite command resolves outside packages\/rsvite/,
    "a command linked out to a host file was accepted as this checkout's",
  );
});

test("a committed command that cannot be executed is refused rather than returned", () => {
  const workspace = workspaceFixture();
  chmodSync(join(workspace.root, "packages/rsvite/bin/rsvite.js"), 0o644);
  workspace.commit("chore: drop the executable bit");
  workspace.publish();
  withSupportedBuild(workspace.root, OUTPUTS);

  assert.throws(
    () => prepareRsviteWorkspace(workspace.root),
    /rsvite command is not executable/,
    "a command the host cannot run was handed back as the subject",
  );
});

test("a package that declares no rsvite command is refused", () => {
  const workspace = workspaceFixture();
  workspace.write(
    "packages/rsvite/package.json",
    `${JSON.stringify({ name: "rsvite", version: "0.0.0" }, null, 2)}\n`,
  );
  workspace.commit("chore: drop the bin entry");
  workspace.publish();
  withSupportedBuild(workspace.root, OUTPUTS);

  assert.throws(() => prepareRsviteWorkspace(workspace.root), /declares no rsvite command/);
});

test("outputs an earlier run left behind are not accepted as this build's", () => {
  const workspace = workspaceFixture();
  writeFileSync(join(workspace.root, "packages/rsvite/native.js"), "export class DevServer {}\n");
  writeFileSync(join(workspace.root, `packages/rsvite/${hostNativeBinaryName()}`), "\0stale\n");
  // Exits zero, writes nothing: running the supported command is not producing its outputs.
  withSupportedBuild(workspace.root, "exit 0");

  assert.throws(
    () => prepareRsviteWorkspace(workspace.root),
    /native\.js loader is missing/,
    "stale outputs from an earlier run were accepted as this invocation's",
  );
});

test("a build that advances protected main is refused, even back to identical bytes", () => {
  const workspace = workspaceFixture();
  const original = "pub fn serve() {}\n";
  withSupportedBuild(
    workspace.root,
    [
      OUTPUTS,
      `printf 'pub fn serve() { /* moved */ }\\n' > crates/rsvite_core/src/lib.rs`,
      `git add -A && git commit --quiet -m 'advance the product'`,
      `printf ${JSON.stringify(original)} > crates/rsvite_core/src/lib.rs`,
      `git add -A && git commit --quiet -m 'restore the bytes'`,
      `git update-ref refs/remotes/origin/main HEAD`,
    ].join("\n"),
  );

  assert.throws(
    () => prepareRsviteWorkspace(workspace.root),
    /became .* while the native build ran/,
    "the subject stayed at the pre-build owner while protected main moved past it",
  );
});

test("an ambient native-library override is refused before anything is built", () => {
  const workspace = workspaceFixture();
  const build = withSupportedBuild(workspace.root, OUTPUTS);
  process.env[NATIVE_LIBRARY_OVERRIDE] = "/tmp/foreign.node";

  try {
    assert.throws(
      () => prepareRsviteWorkspace(workspace.root),
      new RegExp(`${NATIVE_LIBRARY_OVERRIDE} is set`),
      "a recording would have loaded a binary from outside the package",
    );
    assert.deepEqual(build.argv(), [], "the build ran under an override that redirects the loader");
  } finally {
    delete process.env[NATIVE_LIBRARY_OVERRIDE];
  }
});

test("a prepared subject that protected main has moved past is not published", () => {
  const workspace = workspaceFixture();
  withSupportedBuild(workspace.root, OUTPUTS);
  const prepared = prepareRsviteWorkspace(workspace.root);

  // The window between preparing and recording: minutes, during which main can move.
  workspace.write("crates/rsvite_core/src/lib.rs", "pub fn serve() { /* newer */ }\n");
  workspace.commit("feat: advance the product after preparation");
  workspace.publish();

  assert.throws(
    () => {
      assertPreparedSubjectIsStillCurrent(prepared.subject, workspace.root);
    },
    /no longer current/,
    "a subject prepared before the product moved was still treated as publishable",
  );
});
