import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  if (result.error !== undefined || result.status === null) {
    throw new Error(`cannot ${what}: ${String(result.error ?? "git did not run")}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `cannot ${what}: ${result.stderr.trim() || `git exited ${String(result.status)}`}`,
    );
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
 * The commit protected main says owns the rsvite product source, proven to be the one this
 * checkout actually has.
 *
 * Three separate facts, in the order that makes a wrong answer impossible to mistake for a right
 * one: what main owns, that local history agrees, and that the working tree still matches it. A
 * stale branch fails the second; a branch that changed the product fails it too, because its own
 * newer commit becomes the local owner; uncommitted edits fail the third.
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

  const dirty = git(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...RSVITE_PRODUCT_SOURCE_PATHS],
    "inspect the rsvite product source",
  ).trim();
  if (dirty.length > 0) {
    throw new Error(`the rsvite product source must be committed before recording:\n${dirty}`);
  }

  const differs = spawnSync(
    "git",
    ["diff", "--quiet", protectedOwner, "--", ...RSVITE_PRODUCT_SOURCE_PATHS],
    { cwd: root, encoding: "utf8" },
  );
  if (differs.status !== 0) {
    throw new Error(`the rsvite product source differs from ${protectedOwner}`);
  }

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
  /** This checkout's own command. Absolute, and never resolved through PATH. */
  readonly executable: string;
}

export interface PreparationOptions {
  /**
   * Runs the repository's supported native build without cache. Named so a test can drive the
   * failure path without a real toolchain; the default is the task the repository declares.
   */
  readonly build?: (root: string) => void;
}

function defaultBuild(root: string): void {
  execFileSync(join(root, "node_modules/.bin/vp"), ["run", "--no-cache", "build:rsvite:native"], {
    cwd: root,
    stdio: "inherit",
  });
}

/**
 * Everything a recorder must know before it touches an external checkout or writes evidence.
 *
 * The order is the point. Identity is settled first, so a build never runs against a source
 * nobody can name; the build runs before the outputs are required, so a missing binary is
 * reported as a build failure rather than as an absent file; and the command is resolved through
 * this checkout's own package last, so a same-named executable on the host can never stand in for
 * the thing being measured.
 */
export function prepareRsviteWorkspace(
  root = defaultRepositoryRoot,
  options: PreparationOptions = {},
): RsvitePreparation {
  const subject = readRsviteWorkspaceSubject(root);
  (options.build ?? defaultBuild)(root);

  const packageDir = join(root, RSVITE_PACKAGE_DIR);
  const loader = join(packageDir, NATIVE_LOADER);
  if (!existsSync(loader)) {
    throw new Error(`the native build produced no ${NATIVE_LOADER} in ${RSVITE_PACKAGE_DIR}`);
  }
  const platformBinary = readdirSync(packageDir).find((entry) => entry.endsWith(".node"));
  if (platformBinary === undefined) {
    throw new Error(`the native build produced no platform binary in ${RSVITE_PACKAGE_DIR}`);
  }

  return { subject, executable: workspaceExecutable(packageDir) };
}

/** Resolved from the package's own `bin` entry, and required to stay inside that package. */
function workspaceExecutable(packageDir: string): string {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    bin?: Record<string, unknown>;
  };
  const declared = manifest.bin?.["rsvite"];
  if (typeof declared !== "string" || declared.length === 0) {
    throw new Error(`${RSVITE_PACKAGE_DIR} declares no rsvite command`);
  }

  const executable = resolve(packageDir, declared);
  if (!isAbsolute(executable) || !executable.startsWith(packageDir + sep)) {
    throw new Error(`the rsvite command must live inside ${RSVITE_PACKAGE_DIR}: ${executable}`);
  }
  if (!existsSync(executable)) {
    throw new Error(`the rsvite command is missing: ${executable}`);
  }
  return executable;
}
