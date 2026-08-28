import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { prepareRsviteWorkspace } from "../src/index.ts";
import { recordingBuild, workspaceFixture } from "./support.mts";

/** What a real native build leaves behind. */
function buildOutputs(root: string, options: { loader?: boolean; binary?: boolean } = {}): void {
  const dir = join(root, "packages/rsvite");
  if (options.loader !== false)
    writeFileSync(join(dir, "native.js"), "export class DevServer {}\n");
  if (options.binary !== false) writeFileSync(join(dir, "rsvite.linux-x64-gnu.node"), "\0binary\n");
}

test("preparation returns this checkout's own command, absolute", () => {
  const workspace = workspaceFixture();
  const build = recordingBuild();

  const prepared = prepareRsviteWorkspace(workspace.root, {
    build: (root) => {
      build.build(root);
      buildOutputs(root);
    },
  });

  assert.equal(prepared.subject.commit, workspace.owner);
  assert.equal(prepared.executable, join(workspace.root, "packages/rsvite/bin/rsvite.js"));
  assert.equal(build.calls(), 1);
});

test("a same-named command on the host cannot stand in for the workspace command", () => {
  const workspace = workspaceFixture();
  // A decoy exactly where a host lookup would find one first.
  const hostBin = mkdtempSync(join(tmpdir(), "rsvite-host-bin-"));
  const decoy = join(hostBin, "rsvite");
  writeFileSync(decoy, "#!/bin/sh\necho host\n");
  chmodSync(decoy, 0o755);
  const previousPath = process.env["PATH"];
  process.env["PATH"] = `${hostBin}:${previousPath ?? ""}`;

  try {
    const prepared = prepareRsviteWorkspace(workspace.root, { build: buildOutputs });
    assert.equal(prepared.executable, join(workspace.root, "packages/rsvite/bin/rsvite.js"));
    assert.notEqual(prepared.executable, decoy);
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  }
});

test("identity is settled before the build runs", () => {
  const workspace = workspaceFixture();
  workspace.git("checkout", "--quiet", "-b", "topic");
  workspace.write("crates/rsvite_core/src/lib.rs", "pub fn serve() { /* changed */ }\n");
  workspace.commit("feat: change the product on a branch");
  const build = recordingBuild();

  assert.throws(
    () => prepareRsviteWorkspace(workspace.root, { build: build.build }),
    /but protected main's is/,
  );
  assert.equal(
    build.calls(),
    0,
    "the native build ran against a source this checkout could not name",
  );
});

test("a failing native build is reported as a build failure, not as a missing file", () => {
  const workspace = workspaceFixture();

  assert.throws(
    () =>
      prepareRsviteWorkspace(workspace.root, {
        build: () => {
          throw new Error("cargo exited with code 101");
        },
      }),
    /cargo exited with code 101/,
  );
});

test("a build that produces no loader, or no platform binary, is refused", () => {
  const missingLoader = workspaceFixture();
  assert.throws(
    () =>
      prepareRsviteWorkspace(missingLoader.root, {
        build: (root) => buildOutputs(root, { loader: false }),
      }),
    /produced no native\.js/,
  );

  const missingBinary = workspaceFixture();
  assert.throws(
    () =>
      prepareRsviteWorkspace(missingBinary.root, {
        build: (root) => buildOutputs(root, { binary: false }),
      }),
    /produced no platform binary/,
  );
});

test("a package that declares no rsvite command, or whose command is gone, is refused", () => {
  const undeclared = workspaceFixture();
  undeclared.write(
    "packages/rsvite/package.json",
    `${JSON.stringify({ name: "rsvite", version: "0.0.0" }, null, 2)}\n`,
  );
  undeclared.commit("chore: drop the bin entry");
  undeclared.publish();
  assert.throws(
    () => prepareRsviteWorkspace(undeclared.root, { build: buildOutputs }),
    /declares no rsvite command/,
  );

  const missing = workspaceFixture();
  assert.throws(
    () =>
      prepareRsviteWorkspace(missing.root, {
        build: (root) => {
          buildOutputs(root);
          rmSync(join(root, "packages/rsvite/bin/rsvite.js"));
        },
      }),
    /the rsvite command is missing/,
  );
});

test("a command pointed outside the workspace package is refused", () => {
  const workspace = workspaceFixture();
  const outside = mkdtempSync(join(tmpdir(), "rsvite-outside-"));
  mkdirSync(join(outside, "bin"), { recursive: true });
  writeFileSync(join(outside, "bin/rsvite.js"), "#!/usr/bin/env node\n");
  workspace.write(
    "packages/rsvite/package.json",
    `${JSON.stringify(
      { name: "rsvite", version: "0.0.0", bin: { rsvite: join(outside, "bin/rsvite.js") } },
      null,
      2,
    )}\n`,
  );
  workspace.commit("chore: point the command outside the package");
  workspace.publish();

  assert.throws(
    () => prepareRsviteWorkspace(workspace.root, { build: buildOutputs }),
    /must live inside packages\/rsvite/,
  );
});
