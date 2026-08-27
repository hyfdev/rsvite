import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createContractValidators } from "@rsvite/compatibility-contract";

export const VITE_UPSTREAM_REPOSITORY = "https://github.com/vitejs/vite";
export const VITE_UPSTREAM_COMMIT = "ee644014aab61e546742b862a7d7b0d6c7d67a7b";
export const HTML_PRESERVE_COMMENTS_ENTRY_ID = "vite-upstream-html-preserve-comments";

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(srcDir, "..");
const repoRoot = join(packageDir, "../..");

export const vendorRoot = join(repoRoot, "corpus/vite-upstream");
export const corpusManifestPath = join(repoRoot, "corpus/manifest.json");
export const provenancePath = join(packageDir, "provenance.json");
export const viteBaselineDir = join(
  repoRoot,
  "corpus/results/vite-upstream-html-preserve-comments/vite",
);
export const viteBaselineResultPath = join(viteBaselineDir, "result.json");

export interface ProvenanceFile {
  readonly source: string;
  readonly dest: string;
  readonly sha256: string;
}

export interface ProvenanceException {
  readonly dest: string;
  readonly sha256: string;
  readonly reason: string;
}

export interface Provenance {
  readonly repository: string;
  readonly commit: string;
  readonly files: readonly ProvenanceFile[];
  readonly exceptions: readonly ProvenanceException[];
}

export interface ProvenanceViolation {
  readonly path: string;
  readonly message: string;
}

export type ProvenanceCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly violations: readonly ProvenanceViolation[] };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listVendorFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (stat.isFile()) files.push(posixRelative(root, full));
    }
  };
  walk(root);
  return files;
}

function parseProvenance(value: unknown): Provenance | string {
  const record = asRecord(value);
  if (record === undefined) return "provenance is not an object";
  if (record["repository"] !== VITE_UPSTREAM_REPOSITORY) {
    return `repository must be ${VITE_UPSTREAM_REPOSITORY}`;
  }
  if (record["commit"] !== VITE_UPSTREAM_COMMIT) {
    return `commit must be ${VITE_UPSTREAM_COMMIT}`;
  }
  const files = record["files"];
  const exceptions = record["exceptions"];
  if (!Array.isArray(files) || files.length === 0) return "files must be a non-empty array";
  if (!Array.isArray(exceptions)) return "exceptions must be an array";

  const parsedFiles: ProvenanceFile[] = [];
  for (const [index, file] of files.entries()) {
    const entry = asRecord(file);
    const source = entry?.["source"];
    const dest = entry?.["dest"];
    const sha256 = entry?.["sha256"];
    if (typeof source !== "string" || source.length === 0) {
      return `/files/${String(index)}/source is missing`;
    }
    if (typeof dest !== "string" || dest.length === 0) {
      return `/files/${String(index)}/dest is missing`;
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      return `/files/${String(index)}/sha256 is not a SHA-256 hex digest`;
    }
    parsedFiles.push({ source, dest, sha256 });
  }

  const parsedExceptions: ProvenanceException[] = [];
  for (const [index, exception] of exceptions.entries()) {
    const entry = asRecord(exception);
    const dest = entry?.["dest"];
    const sha256 = entry?.["sha256"];
    const reason = entry?.["reason"];
    if (typeof dest !== "string" || dest.length === 0) {
      return `/exceptions/${String(index)}/dest is missing`;
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      return `/exceptions/${String(index)}/sha256 is not a SHA-256 hex digest`;
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      return `/exceptions/${String(index)}/reason is missing`;
    }
    parsedExceptions.push({ dest, sha256, reason: reason.trim() });
  }

  return {
    repository: VITE_UPSTREAM_REPOSITORY,
    commit: VITE_UPSTREAM_COMMIT,
    files: parsedFiles,
    exceptions: parsedExceptions,
  };
}

export function readProvenance(): unknown {
  return JSON.parse(readFileSync(provenancePath, "utf8")) as unknown;
}

export function readCorpusManifest(): unknown {
  return JSON.parse(readFileSync(corpusManifestPath, "utf8")) as unknown;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} is missing`);
  }
  return value;
}

/** Vitest 4.1.11 matches `getTaskFullName`, which joins suite and test names with spaces, not ` > `. */
export function vitestTestNamePattern(fullName: string): string {
  return fullName.replaceAll(" > ", " ");
}

/** Staged, unstaged, or untracked paths, as `git status --porcelain` prints them. */
export function gitWorktreePorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
}

export function assertCleanGitWorktree(cwd: string): void {
  const porcelain = gitWorktreePorcelain(cwd);
  if (porcelain !== "") {
    throw new Error(`git worktree is not clean:\n${porcelain}`);
  }
}

/**
 * Evidence paths in a committed result are relative to that result file. A missing or
 * non-file path is not reproducible evidence.
 */
export function assertResultArtifactsExist(resultPath: string, result: unknown): void {
  const record = asRecord(result);
  const paths = record?.["artifactPaths"];
  if (!Array.isArray(paths)) {
    throw new Error(`${resultPath} has no artifactPaths array`);
  }
  const base = dirname(resultPath);
  for (const [index, entry] of paths.entries()) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`${resultPath} artifactPaths[${String(index)}] is not a path`);
    }
    if (isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
      throw new Error(`${resultPath} artifactPaths[${String(index)}] is not a relative file path`);
    }
    const resolved = join(base, entry);
    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      throw new Error(`${resultPath} names missing evidence ${entry}`);
    }
    if (!stat.isFile()) {
      throw new Error(`${resultPath} names non-file evidence ${entry}`);
    }
  }
}

/**
 * The checkout must be the pinned commit with a clean worktree. Staged, unstaged, or
 * untracked source is not that commit.
 */
export function assertPinnedCleanViteCheckout(checkout: string): void {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf8",
  }).trim();
  if (head !== VITE_UPSTREAM_COMMIT) {
    throw new Error(`VITE_CHECKOUT HEAD is ${head}, expected ${VITE_UPSTREAM_COMMIT}`);
  }
  assertCleanGitWorktree(checkout);
}

function htmlPreserveCommentsEntry(
  manifest: unknown = readCorpusManifest(),
): Record<string, unknown> {
  const entries = asRecord(manifest)?.["entries"];
  if (!Array.isArray(entries)) throw new Error("the corpus manifest has no entries");
  const entry = asRecord(
    entries.find((candidate) => asRecord(candidate)?.["id"] === HTML_PRESERVE_COMMENTS_ENTRY_ID),
  );
  if (entry === undefined) {
    throw new Error(`the corpus manifest has no entry ${HTML_PRESERVE_COMMENTS_ENTRY_ID}`);
  }
  return entry;
}

/** Paths are relative to the vendored copy. */
export function adapterEntryFromManifest(manifest: unknown = readCorpusManifest()) {
  const extension = asRecord(
    asRecord(htmlPreserveCommentsEntry(manifest)["extensions"])?.["x-vite-upstream"],
  );
  return {
    entryId: HTML_PRESERVE_COMMENTS_ENTRY_ID,
    testName: requiredString(extension?.["testName"], "x-vite-upstream.testName"),
    spec: requiredString(extension?.["spec"], "x-vite-upstream.spec"),
    importedRoot: requiredString(extension?.["importedRoot"], "x-vite-upstream.importedRoot"),
  };
}

export function htmlPreserveCommentsPackageManager(manifest: unknown = readCorpusManifest()): {
  name: string;
  version: string;
} {
  const pm = asRecord(
    asRecord(htmlPreserveCommentsEntry(manifest)["lockfile"])?.["packageManager"],
  );
  return {
    name: requiredString(pm?.["name"], "lockfile.packageManager.name"),
    version: requiredString(pm?.["version"], "lockfile.packageManager.version"),
  };
}

export function htmlPreserveCommentsCommandExecutable(
  commandName: "install" | "test",
  manifest: unknown = readCorpusManifest(),
): string {
  const argv = asRecord(asRecord(htmlPreserveCommentsEntry(manifest)["commands"])?.[commandName])?.[
    "argv"
  ];
  if (!Array.isArray(argv) || typeof argv[0] !== "string" || argv[0].length === 0) {
    throw new Error(`commands.${commandName}.argv[0] is missing`);
  }
  return argv[0];
}

/** The adopted Vite baseline is Linux x64. Other hosts must not be labeled as that environment. */
export function assertLinuxX64Host(
  platform = process.platform,
  arch = process.arch,
): { os: string; arch: string } {
  if (platform !== "linux" || arch !== "x64") {
    throw new Error(`host is ${platform}/${arch}, expected linux/x64`);
  }
  return { os: platform, arch };
}

/**
 * `--version` of the executable the runner will spawn. Pass the Vite checkout as `cwd`.
 */
export function assertPnpmVersion(
  executable: string,
  expectedVersion: string,
  options: { cwd?: string } = {},
): string {
  const version = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    cwd: options.cwd,
  }).trim();
  if (version !== expectedVersion) {
    throw new Error(`${executable} --version is ${version}, expected ${expectedVersion}`);
  }
  return version;
}

export function corepackCachedPnpmCjs(version: string): string {
  const home =
    process.env["COREPACK_HOME"] ??
    join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "node/corepack");
  return join(home, "v1", "pnpm", version, "bin", "pnpm.cjs");
}

/**
 * A Corepack parent already pinned to another pnpm cannot switch versions. Put a bare
 * lockfile pnpm first on PATH so install and test spawn that version.
 */
export function ensureManifestPnpmOnPath(version: string): string {
  execFileSync("corepack", ["install", "-g", `pnpm@${version}`, "--cache-only"], {
    encoding: "utf8",
  });
  const pnpmCjs = corepackCachedPnpmCjs(version);
  if (!existsSync(pnpmCjs)) {
    throw new Error(`corepack did not cache pnpm@${version} at ${pnpmCjs}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "rsvite-pnpm-"));
  const wrapper = join(dir, "pnpm");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(pnpmCjs)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  process.env["PATH"] = `${dir}${delimiter}${process.env["PATH"] ?? ""}`;
  return wrapper;
}

export const htmlPreserveCommentsAdapter = adapterEntryFromManifest();

/**
 * Every imported file must match the recorded upstream digest, unless an exception names that
 * path, the current digest, and a reason. An extra file, a missing file, or a digest change
 * without an exception is an unrecorded edit.
 */
export function checkImportedFileProvenance(value: unknown = readProvenance()): ProvenanceCheck {
  const parsed = parseProvenance(value);
  if (typeof parsed === "string") {
    return { valid: false, violations: [{ path: "", message: parsed }] };
  }

  const violations: ProvenanceViolation[] = [];
  const recorded = new Map<string, ProvenanceFile>();
  for (const [index, file] of parsed.files.entries()) {
    if (recorded.has(file.dest)) {
      violations.push({
        path: `/files/${String(index)}/dest`,
        message: `duplicates an earlier dest (${file.dest})`,
      });
      continue;
    }
    recorded.set(file.dest, file);
  }

  const exceptionByDest = new Map<string, ProvenanceException>();
  for (const [index, exception] of parsed.exceptions.entries()) {
    if (!recorded.has(exception.dest)) {
      violations.push({
        path: `/exceptions/${String(index)}/dest`,
        message: `names a dest that is not imported (${exception.dest})`,
      });
      continue;
    }
    if (exceptionByDest.has(exception.dest)) {
      violations.push({
        path: `/exceptions/${String(index)}/dest`,
        message: `duplicates an earlier exception (${exception.dest})`,
      });
      continue;
    }
    exceptionByDest.set(exception.dest, exception);
  }

  for (const file of recorded.values()) {
    const destPath = join(vendorRoot, file.dest);
    let actual: string;
    try {
      actual = sha256Of(destPath);
    } catch {
      violations.push({
        path: file.dest,
        message: "is recorded but missing from the vendored copy",
      });
      continue;
    }
    const exception = exceptionByDest.get(file.dest);
    if (exception === undefined) {
      if (actual !== file.sha256) {
        violations.push({
          path: file.dest,
          message: `differs from the recorded upstream digest (${file.sha256})`,
        });
      }
      continue;
    }
    if (actual !== exception.sha256) {
      violations.push({
        path: file.dest,
        message: `does not match its recorded exception digest (${exception.sha256})`,
      });
    }
  }

  for (const dest of listVendorFiles(vendorRoot)) {
    if (!recorded.has(dest)) {
      violations.push({
        path: dest,
        message: "is present in the vendored copy but not recorded",
      });
    }
  }

  if (!recorded.has("LICENSE")) {
    violations.push({ path: "LICENSE", message: "the preserved license is not recorded" });
  }

  return violations.length === 0 ? { valid: true } : { valid: false, violations };
}

export function validateCorpusManifestDocument(value: unknown = readCorpusManifest()) {
  return createContractValidators().validateCorpusManifest(value);
}
