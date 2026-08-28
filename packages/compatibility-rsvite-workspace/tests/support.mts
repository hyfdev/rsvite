import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface WorkspaceFixture {
  readonly root: string;
  /** The commit protected main says owns the product source. */
  readonly owner: string;
  git(...args: string[]): string;
  write(path: string, body: string): void;
  commit(message: string): string;
  /** Moves protected main to the current commit, as a merge to main would. */
  publish(): void;
}

/**
 * A real repository shaped like this one: product source, an unrelated root file, and a
 * `refs/remotes/origin/main` that stands for protected main. Real git, because every rule here is
 * a statement about git and a description of git would not test it.
 */
export function workspaceFixture(version = "0.0.0"): WorkspaceFixture {
  const root = mkdtempSync(join(tmpdir(), "rsvite-workspace-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const write = (path: string, body: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };

  git("init", "--quiet");
  // Named explicitly: the rule under test is about a branch called main, not about whatever
  // default this host git happens to use.
  git("symbolic-ref", "HEAD", "refs/heads/main");
  git("config", "user.email", "recorder@example.invalid");
  git("config", "user.name", "recorder");

  write("Cargo.toml", `[workspace]\nmembers = ["crates/rsvite_core"]\n`);
  write("Cargo.lock", "# lock\n");
  write("crates/rsvite_core/src/lib.rs", "pub fn serve() {}\n");
  write("crates/rsvite_binding/src/lib.rs", "// binding\n");
  write(
    "packages/rsvite/package.json",
    `${JSON.stringify({ name: "rsvite", version, bin: { rsvite: "./bin/rsvite.js" } }, null, 2)}\n`,
  );
  write("packages/rsvite/bin/rsvite.js", "#!/usr/bin/env node\n");
  // Recording environment, not product source.
  write("vite.config.ts", "export default {};\n");
  write("packages/rsvite/tests/cli.test.mjs", "// test\n");

  const commit = (message: string): string => {
    git("add", "--all");
    git("commit", "--quiet", "--message", message);
    return git("rev-parse", "HEAD");
  };
  const publish = (): void => {
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  };

  const owner = commit("product source");
  publish();

  return { root, owner, git, write, commit, publish };
}

/** A build that records it ran, so a test can prove what happened before it. */
export function recordingBuild(): { build: (root: string) => void; calls(): number } {
  let calls = 0;
  return {
    calls: () => calls,
    build: () => {
      calls += 1;
    },
  };
}
