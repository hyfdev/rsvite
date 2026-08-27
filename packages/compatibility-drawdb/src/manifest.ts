import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeclaredRunInputs } from "@rsvite/compatibility-runner";

export const DRAWDB_ENTRY_ID = "drawdb";
export const DRAWDB_REPOSITORY = "https://github.com/drawdb-io/drawdb";
export const DRAWDB_COMMIT = "031aef1f1c1d3f9027ccfacbf084e9c1a31b8abc";
export const DRAWDB_LICENSE_PATH = "LICENSE";
export const DRAWDB_LOCKFILE = "package-lock.json";
export const DRAWDB_EDITOR_PATH = "/editor";
export const DRAWDB_SENTINEL = "globalThis.__rsviteDrawDbHmrSentinel";

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(srcDir, "..");
const repoRoot = join(packageDir, "../..");
const npmBinDir = join(packageDir, "node_modules", ".bin");
const rsviteBinDir = join(repoRoot, "node_modules", ".bin");

export const corpusManifestPath = join(repoRoot, "corpus/manifest.json");
export const drawDbEvidenceRoot = join(repoRoot, "corpus/results/drawdb");
export const drawDbEvidenceResultPaths = {
  vite: {
    dev: join(drawDbEvidenceRoot, "vite/dev/result.json"),
    build: join(drawDbEvidenceRoot, "vite/build/result.json"),
    preview: join(drawDbEvidenceRoot, "vite/preview/result.json"),
  },
  rsvite: {
    dev: join(drawDbEvidenceRoot, "rsvite/dev/result.json"),
  },
} as const;

export type DrawDbSubject = "vite" | "rsvite";

export type DrawDbViteLifecycle = "dev" | "build" | "preview";

export type DrawDbRun =
  | {
      readonly lifecycle: DrawDbViteLifecycle;
      readonly subject: "vite";
    }
  | {
      readonly lifecycle: "dev";
      readonly subject: "rsvite";
    };

export type DrawDbManifestOptions = DrawDbRun & {
  readonly port: number;
};

export interface DrawDbHmrEdit {
  readonly find: string;
  readonly path: string;
  readonly replace: string;
}

type DrawDbLifecycle = DrawDbRun["lifecycle"];

const DEV_CAPABILITIES = [
  "html",
  "modules-and-assets",
  "resolution",
  "errors",
  "file-watching",
  "hmr-without-full-reload",
  "framework-lifecycle",
] as const;
const BUILD_CAPABILITIES = ["build-output"] as const;
const PREVIEW_CAPABILITIES = [
  "html",
  "modules-and-assets",
  "resolution",
  "errors",
  "preview-output",
  "framework-lifecycle",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readCorpusManifest(): unknown {
  return JSON.parse(readFileSync(corpusManifestPath, "utf8")) as unknown;
}

export function rsviteWorkspaceVersion(): string {
  const workspacePackage = asRecord(
    JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as unknown,
  );
  if (typeof workspacePackage?.["version"] !== "string") {
    throw new Error("the workspace package must declare a version");
  }
  return workspacePackage["version"];
}

/** The static corpus entry is the durable DrawDB declaration; run-specific details are patched on a clone. */
export function drawDbEntryFromManifest(
  manifest: unknown = readCorpusManifest(),
): Record<string, unknown> {
  const entries = asRecord(manifest)?.["entries"];
  if (!Array.isArray(entries)) throw new Error("the corpus manifest has no entries");
  const entry = asRecord(
    entries.find((candidate) => asRecord(candidate)?.["id"] === DRAWDB_ENTRY_ID),
  );
  if (entry === undefined) throw new Error(`the corpus manifest has no entry ${DRAWDB_ENTRY_ID}`);
  return entry;
}

export function drawDbNpmVersion(manifest: unknown = readCorpusManifest()): string {
  const lockfile = asRecord(drawDbEntryFromManifest(manifest)["lockfile"]);
  const packageManager = asRecord(lockfile?.["packageManager"]);
  if (packageManager?.["name"] !== "npm" || typeof packageManager["version"] !== "string") {
    throw new Error("the DrawDB corpus entry must pin an npm version");
  }
  return packageManager["version"];
}

export function drawDbHmrEdit(manifest: unknown = readCorpusManifest()): DrawDbHmrEdit {
  const browserAcceptance = asRecord(drawDbEntryFromManifest(manifest)["browserAcceptance"]);
  const hmr = asRecord(browserAcceptance?.["hmr"]);
  const edit = asRecord(hmr?.["edit"]);
  const path = edit?.["path"];
  const find = edit?.["find"];
  const replace = edit?.["replace"];
  if (typeof path !== "string" || typeof find !== "string" || typeof replace !== "string") {
    throw new Error("the DrawDB corpus entry must declare an HMR edit");
  }
  return { path, find, replace };
}

/** Commands preserve DrawDB's original npm argv while resolving npm from this locked package. */
export function drawDbCommandEnvironment(): Readonly<Record<string, string>> {
  const inheritedPath = process.env["PATH"];
  return { PATH: inheritedPath ? `${npmBinDir}${delimiter}${inheritedPath}` : npmBinDir };
}

function rsviteCommandEnvironment(): Readonly<Record<string, string>> {
  const inheritedPath = process.env["PATH"];
  return {
    PATH: inheritedPath
      ? `${rsviteBinDir}${delimiter}${npmBinDir}${delimiter}${inheritedPath}`
      : `${rsviteBinDir}${delimiter}${npmBinDir}`,
  };
}

/** Evidence paths are relative to their result file and must name files preserved with it. */
export function assertDrawDbResultArtifactsExist(resultPath: string, result: unknown): void {
  const paths = asRecord(result)?.["artifactPaths"];
  if (!Array.isArray(paths)) {
    throw new Error(`${resultPath} has no artifactPaths array`);
  }
  const base = dirname(resultPath);
  for (const [index, path] of paths.entries()) {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error(`${resultPath} artifactPaths[${String(index)}] is not a path`);
    }
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
      throw new Error(`${resultPath} artifactPaths[${String(index)}] is not a relative file path`);
    }
    const resolved = join(base, path);
    let artifact;
    try {
      artifact = statSync(resolved);
    } catch {
      throw new Error(`${resultPath} names missing evidence ${path}`);
    }
    if (!artifact.isFile()) throw new Error(`${resultPath} names non-file evidence ${path}`);
  }
}

function viteCommandFor(lifecycle: DrawDbViteLifecycle, port: number): readonly string[] {
  switch (lifecycle) {
    case "dev":
      return ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)];
    case "build":
      return ["npm", "run", "build"];
    case "preview":
      return ["npm", "run", "preview", "--", "--host", "127.0.0.1", "--port", String(port)];
  }
}

function rsviteDevCommand(port: number): readonly string[] {
  return ["rsvite", ".", "--port", String(port)];
}

function assertDrawDbRunIsSupported(subject: string, lifecycle: string): void {
  if (subject === "vite" && ["dev", "build", "preview"].includes(lifecycle)) return;
  if (subject === "rsvite" && lifecycle === "dev") return;
  throw new Error(`DrawDB does not support ${subject} ${lifecycle}`);
}

function readinessFor(lifecycle: DrawDbLifecycle): Record<string, unknown> {
  if (lifecycle === "build") return { type: "process-exit", timeoutMs: 300_000 };
  return {
    type: "http-ready",
    urlPath: DRAWDB_EDITOR_PATH,
    expectStatus: 200,
    timeoutMs: 120_000,
  };
}

/**
 * The static corpus entry declares the pinned source, package manager, and original Vite
 * lifecycle. A runner needs its own port, subject command, and build readiness, so it receives a
 * clone rather than mutating that durable declaration.
 */
export function createDrawDbManifest(options: DrawDbManifestOptions): unknown {
  assertDrawDbRunIsSupported(options.subject, options.lifecycle);
  const manifest = structuredClone(readCorpusManifest()) as Record<string, unknown>;
  const entry = drawDbEntryFromManifest(manifest);
  drawDbNpmVersion(manifest);

  const commands = {
    install: { argv: ["npm", "ci"], env: drawDbCommandEnvironment() },
    dev: { argv: viteCommandFor("dev", options.port), env: drawDbCommandEnvironment() },
    build: { argv: viteCommandFor("build", options.port), env: drawDbCommandEnvironment() },
    preview: { argv: viteCommandFor("preview", options.port), env: drawDbCommandEnvironment() },
  };
  if (options.subject === "rsvite") {
    commands.dev = { argv: rsviteDevCommand(options.port), env: rsviteCommandEnvironment() };
  }
  entry["commands"] = commands;
  entry["readiness"] = readinessFor(options.lifecycle);
  return manifest;
}

function capabilitiesFor(lifecycle: DrawDbLifecycle): readonly string[] {
  switch (lifecycle) {
    case "dev":
      return DEV_CAPABILITIES;
    case "build":
      return BUILD_CAPABILITIES;
    case "preview":
      return PREVIEW_CAPABILITIES;
  }
}

/** Product judgment stays with the adapter; the shared runner only records it. */
export function declaredDrawDbRun(run: DrawDbRun): DeclaredRunInputs {
  assertDrawDbRunIsSupported(run.subject, run.lifecycle);
  const owner = run.subject === "vite" ? "vite" : "rust";
  return {
    javascriptApiLevel: run.subject === "vite" ? "C2" : "C0",
    capabilityOwners: capabilitiesFor(run.lifecycle).map((capability) => ({ capability, owner })),
    explicitFallbacks: [],
    classifyFailure: (failure) => ({
      kind: "current-compatibility-requirement",
      evidence:
        run.subject === "vite"
          ? `The pinned DrawDB Vite baseline failed during ${failure.phase}: ${failure.message}`
          : `The rsvite workspace command failed during ${failure.phase} before DrawDB could exercise the selected ${run.lifecycle} capabilities: ${failure.message}`,
    }),
  };
}
