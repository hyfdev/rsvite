import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = join(srcDir, "../../..");

/**
 * The files whose content is the rsvite product.
 *
 * Everything else a recording touches — root task orchestration, package tests, the compatibility
 * adapters, recorder dependencies — is the environment the recording runs in. Mixing the two is
 * what let a change to root `vite.config.ts` stale a result that describes a product it never
 * altered, and it is why a topic commit outside these paths must never become `subject.commit`.
 */
export const RSVITE_PRODUCT_SOURCE_PATHS = [
  "Cargo.lock",
  "Cargo.toml",
  "crates/rsvite_binding",
  "crates/rsvite_core",
  "packages/rsvite/bin",
  "packages/rsvite/package.json",
] as const;

/** Where the durable answer lives. A recording is about what protected main contains. */
const PROTECTED_SOURCE_REF = "refs/remotes/origin/main";

const RSVITE_PACKAGE_DIR = "packages/rsvite";
const NATIVE_LOADER = "native.js";

export interface RsviteWorkspaceSubject {
  readonly name: "rsvite";
  readonly version: string;
  readonly commit: string;
}

function git(root: string, args: readonly string[], what: string): string {
  const result = spawnSync("git", [...args], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status === null) {
    throw new Error(`cannot ${what}: ${String(result.error ?? "git did not run")}`);
  }
  if (result.status !== 0) {
    throw new Error(`cannot ${what}: ${result.stderr.toString().trim() || "git failed"}`);
  }
  return result.stdout.toString();
}

function gitBytes(root: string, args: readonly string[], what: string): Buffer {
  const result = spawnSync("git", [...args], { cwd: root, maxBuffer: 512 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`cannot ${what}`);
  }
  return result.stdout;
}

function requireProtectedRef(root: string): void {
  const present = spawnSync("git", ["rev-parse", "--verify", "--quiet", PROTECTED_SOURCE_REF], {
    cwd: root,
    encoding: "utf8",
  });
  if (present.status !== 0) {
    throw new Error(
      `this checkout has no ${PROTECTED_SOURCE_REF}, so it cannot say what protected main owns; fetch it with \`git fetch origin main\``,
    );
  }
}

function ownerOf(root: string, ref: string, what: string): string {
  const commit = git(
    root,
    ["log", "-1", "--format=%H", ref, "--", ...RSVITE_PRODUCT_SOURCE_PATHS],
    what,
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`${what} found no commit that owns the rsvite product source`);
  }
  return commit;
}

/**
 * Rejects a working tree that told git to stop looking at product source.
 *
 * `assume-unchanged` and `skip-worktree` are honoured by `git status` and by `git diff` alike, so
 * a file carrying either flag can be edited and still report as pristine to both. Every check
 * below reads the file itself, but a flag that makes git lie about the product is a fact about
 * this checkout that a recording must refuse rather than work around.
 */
function assertNoHiddenIndexFlags(root: string): void {
  const listed = git(
    root,
    ["ls-files", "-v", "--", ...RSVITE_PRODUCT_SOURCE_PATHS],
    "list the rsvite product source",
  );
  const hidden = listed
    .split("\n")
    .filter((line) => /^[a-z]/.test(line) || line.startsWith("S"))
    .map((line) => line.slice(2));
  if (hidden.length > 0) {
    throw new Error(
      `the rsvite product source has assume-unchanged or skip-worktree set, so git cannot report its state: ${hidden
        .slice(0, 3)
        .join(", ")}`,
    );
  }
}

/**
 * Compares the working tree against the owner's blobs directly.
 *
 * `git diff` consults the index, and the index is exactly what a hidden flag corrupts. Reading
 * each blob and each file settles the question with the bytes themselves.
 */
function assertProductSourceMatches(root: string, owner: string): void {
  assertNoHiddenIndexFlags(root);

  // Modes matter as much as bytes: git records a symlink as a blob holding its target, and it
  // records the executable bit, so comparing file contents alone would both misread a link and
  // miss a permission change the owner never had.
  const tracked = git(
    root,
    ["ls-tree", "-r", owner, "--", ...RSVITE_PRODUCT_SOURCE_PATHS],
    `list the rsvite product source at ${owner}`,
  )
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [meta, path] = line.split("\t");
      return { mode: (meta ?? "").split(" ")[0] ?? "", path: path ?? "" };
    });
  if (tracked.length === 0) {
    throw new Error(`${owner} contains no rsvite product source`);
  }

  for (const { mode, path } of tracked) {
    const expected = gitBytes(root, ["cat-file", "blob", `${owner}:${path}`], `read ${path}`);
    const full = join(root, path);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      throw new Error(`the rsvite product source is missing ${path} from ${owner}`);
    }

    if (mode === "120000") {
      if (!stat.isSymbolicLink() || readlinkSync(full) !== expected.toString()) {
        throw new Error(`the rsvite product source differs from ${owner} at ${path}`);
      }
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || !expected.equals(readFileSync(full))) {
      throw new Error(`the rsvite product source differs from ${owner} at ${path}`);
    }
    const executable = (stat.mode & 0o111) !== 0;
    if (executable !== (mode === "100755")) {
      throw new Error(`the rsvite product source has a different mode from ${owner} at ${path}`);
    }
  }

  const extra = git(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...RSVITE_PRODUCT_SOURCE_PATHS],
    "inspect the rsvite product source",
  ).trim();
  if (extra.length > 0) {
    throw new Error(`the rsvite product source must be committed before recording:\n${extra}`);
  }
}

/**
 * The commit protected main says owns the rsvite product source, proven to be the one this
 * checkout actually has.
 *
 * Three separate facts, in the order that makes a wrong answer impossible to mistake for a right
 * one: what main owns, that local history agrees, and that the files on disk are that commit's
 * bytes. A stale branch fails the second; a branch that changed the product fails it too, because
 * its own newer commit becomes the local owner; an edited file fails the third.
 */
export function resolveRsviteSourceOwner(root = defaultRepositoryRoot): string {
  requireProtectedRef(root);
  const protectedOwner = ownerOf(root, PROTECTED_SOURCE_REF, "read the protected rsvite source");
  const localOwner = ownerOf(root, "HEAD", "read this checkout's rsvite source");
  if (localOwner !== protectedOwner) {
    throw new Error(
      `this checkout's rsvite product source owner is ${localOwner}, but protected main's is ${protectedOwner}`,
    );
  }

  assertProductSourceMatches(root, protectedOwner);
  return protectedOwner;
}

/** Name and version read from the matched source itself, not from whatever the tree holds now. */
export function readRsviteWorkspaceSubject(root = defaultRepositoryRoot): RsviteWorkspaceSubject {
  const commit = resolveRsviteSourceOwner(root);
  const path = `${RSVITE_PACKAGE_DIR}/package.json`;
  const raw = git(root, ["show", `${commit}:${path}`], `read ${path} at ${commit}`);

  let metadata: { name?: unknown; version?: unknown };
  try {
    metadata = JSON.parse(raw) as { name?: unknown; version?: unknown };
  } catch (error) {
    throw new Error(`${path} at ${commit} is not valid JSON: ${String(error)}`);
  }
  if (metadata.name !== "rsvite") {
    throw new Error(`${path} at ${commit} must declare the package name rsvite`);
  }
  if (typeof metadata.version !== "string" || metadata.version.length === 0) {
    throw new Error(`${path} at ${commit} must declare a non-empty string version`);
  }

  return { name: "rsvite", version: metadata.version, commit };
}

/**
 * A committed result stays current while only the recording environment moved. It goes stale the
 * moment protected main owns a different product source, because that result describes a product
 * this repository no longer builds.
 */
export function assertRsviteResultSubjectIsCurrent(
  subject: unknown,
  root = defaultRepositoryRoot,
): void {
  const current = readRsviteWorkspaceSubject(root);
  const recorded =
    typeof subject === "object" && subject !== null && !Array.isArray(subject)
      ? (subject as Record<string, unknown>)
      : undefined;

  if (recorded?.["name"] !== current.name) {
    throw new Error(`an rsvite result subject must be named ${current.name}`);
  }
  if (recorded["version"] !== current.version) {
    throw new Error(
      `an rsvite result subject must record version ${current.version}, not ${String(recorded["version"])}`,
    );
  }
  if (recorded["commit"] !== current.commit) {
    throw new Error(
      `an rsvite result subject must record the current product source ${current.commit}, not ${String(recorded["commit"])}`,
    );
  }
}

export interface RsvitePreparation {
  readonly subject: RsviteWorkspaceSubject;
  /** This checkout's own command. Absolute, canonical, and never resolved through PATH. */
  readonly executable: string;
}

/**
 * Everything a recorder must know before it touches an external checkout or writes evidence.
 *
 * There is no way to supply a different build: the supported one is the only thing whose output
 * this may accept, and a caller able to substitute it could record a subject the repository never
 * produced. The order is the rest of the guarantee — identity is settled before the build runs,
 * the source is proven again afterwards because the build is defined by files the product source
 * deliberately excludes, and the command is resolved through this checkout's own package last, so
 * a same-named executable on the host can never stand in for the thing being measured.
 */
export function prepareRsviteWorkspace(root = defaultRepositoryRoot): RsvitePreparation {
  const subject = readRsviteWorkspaceSubject(root);
  runSupportedNativeBuild(root);
  // The build runs whatever root task orchestration says, and that orchestration is not product
  // source, so a build is free to have changed the product under us.
  assertProductSourceMatches(root, subject.commit);

  const packageDir = realpathSync(join(root, RSVITE_PACKAGE_DIR));
  requireContainedRegularFile(
    packageDir,
    join(packageDir, NATIVE_LOADER),
    `the ${NATIVE_LOADER} loader`,
  );
  requirePlatformBinary(packageDir);

  return { subject, executable: workspaceExecutable(packageDir) };
}

function runSupportedNativeBuild(root: string): void {
  execFileSync(join(root, "node_modules/.bin/vp"), ["run", "--no-cache", "build:rsvite:native"], {
    cwd: root,
    stdio: "inherit",
  });
}

/** A name that exists is not a file, and a path inside the package is not a file inside it. */
function requireContainedRegularFile(packageDir: string, path: string, what: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new Error(`${what} is missing from ${RSVITE_PACKAGE_DIR}`);
  }
  if (!canonical.startsWith(packageDir + sep)) {
    throw new Error(`${what} resolves outside ${RSVITE_PACKAGE_DIR}: ${canonical}`);
  }
  if (!lstatSync(canonical).isFile()) {
    throw new Error(`${what} is not a regular file: ${canonical}`);
  }
  return canonical;
}

/** The binary this host would actually load, not any `.node` the directory happens to hold. */
function requirePlatformBinary(packageDir: string): string {
  const expected = `rsvite.${process.platform}-${process.arch}`;
  const candidates = readdirSync(packageDir).filter(
    (entry) => entry.startsWith(`${expected}`) && entry.endsWith(".node"),
  );
  const name = candidates[0];
  if (name === undefined) {
    const seen = readdirSync(packageDir).filter((entry) => entry.endsWith(".node"));
    throw new Error(
      `the native build produced no ${expected}*.node in ${RSVITE_PACKAGE_DIR}${
        seen.length > 0 ? `; it produced ${seen.join(", ")}` : ""
      }`,
    );
  }
  return requireContainedRegularFile(packageDir, join(packageDir, name), `the ${name} binary`);
}

/** Resolved from the package's own `bin` entry, required to stay inside it, and runnable. */
function workspaceExecutable(packageDir: string): string {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    bin?: Record<string, unknown>;
  };
  const declared = manifest.bin?.["rsvite"];
  if (typeof declared !== "string" || declared.length === 0) {
    throw new Error(`${RSVITE_PACKAGE_DIR} declares no rsvite command`);
  }

  const executable = requireContainedRegularFile(
    packageDir,
    resolve(packageDir, declared),
    "the rsvite command",
  );
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    throw new Error(`the rsvite command is not executable: ${executable}`);
  }
  return executable;
}
