import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
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

/** Paths are relative to the vendored copy. */
export function adapterEntryFromManifest(manifest: unknown = readCorpusManifest()) {
  const entries = asRecord(manifest)?.["entries"];
  if (!Array.isArray(entries)) throw new Error("the corpus manifest has no entries");
  const entry = asRecord(
    entries.find((candidate) => asRecord(candidate)?.["id"] === HTML_PRESERVE_COMMENTS_ENTRY_ID),
  );
  if (entry === undefined) {
    throw new Error(`the corpus manifest has no entry ${HTML_PRESERVE_COMMENTS_ENTRY_ID}`);
  }
  const extension = asRecord(asRecord(entry["extensions"])?.["x-vite-upstream"]);
  return {
    entryId: HTML_PRESERVE_COMMENTS_ENTRY_ID,
    testName: requiredString(extension?.["testName"], "x-vite-upstream.testName"),
    spec: requiredString(extension?.["spec"], "x-vite-upstream.spec"),
    importedRoot: requiredString(extension?.["importedRoot"], "x-vite-upstream.importedRoot"),
  };
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
