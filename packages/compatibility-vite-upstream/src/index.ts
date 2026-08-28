import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContractValidators } from "@rsvite/compatibility-contract";

export const VITE_UPSTREAM_REPOSITORY = "https://github.com/vitejs/vite";
export const VITE_UPSTREAM_COMMIT = "ee644014aab61e546742b862a7d7b0d6c7d67a7b";
export const VITE_UPSTREAM_VITEST_VERSION = "4.1.11";
export const HTML_PRESERVE_COMMENTS_ENTRY_ID = "vite-upstream-html-preserve-comments";
export const VITE_UPSTREAM_BROWSER_OBSERVATION = "nested-vitest-browser-not-observed-by-runner";

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
export const rsviteBaselineDir = join(
  repoRoot,
  "corpus/results/vite-upstream-html-preserve-comments/rsvite",
);
export const rsviteBaselineResultPath = join(rsviteBaselineDir, "result.json");
export const rsviteUpstreamConfigPath = join(repoRoot, "packages/rsvite/vite.upstream.config.ts");

export interface VitestInstallation {
  readonly executable: string;
  readonly version: string;
}

function readVitestInstallation(
  projectRoot: string,
  installationRoot = projectRoot,
): VitestInstallation {
  const require = createRequire(join(projectRoot, "package.json"));
  const packageJson = require.resolve("vitest/package.json");
  const projectRelativePackage = relative(installationRoot, packageJson);
  if (
    projectRelativePackage === "" ||
    isAbsolute(projectRelativePackage) ||
    projectRelativePackage.split(sep)[0] === ".."
  ) {
    throw new Error(`Vitest resolved outside the declared project root: ${packageJson}`);
  }

  const metadata = asRecord(JSON.parse(readFileSync(packageJson, "utf8")) as unknown);
  const version = requiredString(metadata?.["version"], "vitest.version");
  const bin = metadata?.["bin"];
  const executableRelative =
    typeof bin === "string" ? bin : requiredString(asRecord(bin)?.["vitest"], "vitest.bin.vitest");
  const executable = join(dirname(packageJson), executableRelative);
  if (!statSync(executable).isFile()) {
    throw new Error(`Vitest executable is not a file: ${executable}`);
  }
  return { executable, version };
}

/** The assertion runner installed by the exact external Vite lockfile. */
export function viteVitestInstallation(checkout: string): VitestInstallation {
  const installation = readVitestInstallation(checkout);
  if (installation.version !== VITE_UPSTREAM_VITEST_VERSION) {
    throw new Error(
      `pinned Vite checkout installed Vitest ${installation.version}, expected ${VITE_UPSTREAM_VITEST_VERSION}`,
    );
  }
  return installation;
}

/** The exact-version local runner used only by the no-network daily parity probe. */
export function workspaceVitestInstallation(): VitestInstallation {
  const installation = readVitestInstallation(packageDir, repoRoot);
  if (installation.version !== VITE_UPSTREAM_VITEST_VERSION) {
    throw new Error(
      `rsvite workspace installed Vitest ${installation.version}, expected ${VITE_UPSTREAM_VITEST_VERSION}`,
    );
  }
  return installation;
}

const expectedRsviteFailureError =
  "rsvite did not fail only at the pinned preserve-comments assertion; refusing to accept the expected C0 execution";

function assertExecution(condition: unknown): asserts condition {
  if (!condition) throw new Error(expectedRsviteFailureError);
}

/**
 * Accepts the negative C0 evidence only when the entire Vitest execution contains the selected
 * assertion failure and nothing else. The recorder, committed artifacts, and daily live probe all
 * call this same boundary.
 */
export function assertExpectedRsviteHtmlPreserveCommentsExecution(
  report: {
    readonly failure?: { readonly phase: string; readonly message: string };
  },
  logs: { readonly stdout: string; readonly stderr: string },
): void {
  assertExecution(report.failure?.phase === "test");
  assertExecution(report.failure.message === "test exited with code 1");

  const jsonReports: unknown[] = [];
  for (const line of logs.stdout.split(/\r?\n/)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (asRecord(value)?.["numTotalTestSuites"] === undefined) {
      continue;
    }
    jsonReports.push(value);
  }
  assertExecution(jsonReports.length === 1);
  const summary = asRecord(jsonReports[0]);
  assertExecution(summary !== undefined);
  assertExecution(summary["success"] === false);
  assertExecution(summary["numFailedTests"] === 1);

  const testResults = summary["testResults"];
  assertExecution(Array.isArray(testResults) && testResults.length === 1);
  const file = asRecord(testResults[0]);
  assertExecution(file !== undefined);
  assertExecution(file["status"] === "failed");
  assertExecution(file["message"] === "");
  const spec = file["name"];
  assertExecution(
    typeof spec === "string" &&
      spec.replaceAll("\\", "/").endsWith("/playground/html/__tests__/html.spec.ts"),
  );

  const assertions = file["assertionResults"];
  assertExecution(Array.isArray(assertions));
  const failed = assertions.filter((value) => asRecord(value)?.["status"] === "failed");
  const skipped = assertions.filter((value) => asRecord(value)?.["status"] === "skipped");
  assertExecution(failed.length === 1);
  assertExecution(
    assertions.every((value) => {
      const assertion = asRecord(value);
      return assertion?.["status"] === "failed" || assertion?.["status"] === "skipped";
    }),
  );

  const assertion = asRecord(failed[0]);
  assertExecution(assertion?.["fullName"] === "main preserve comments");
  assertExecution(assertion["title"] === "preserve comments");
  assertExecution(
    Array.isArray(assertion["ancestorTitles"]) &&
      assertion["ancestorTitles"].length === 1 &&
      assertion["ancestorTitles"][0] === "main",
  );
  const failureMessages = assertion["failureMessages"];
  assertExecution(Array.isArray(failureMessages) && failureMessages.length === 1);
  const failure = failureMessages[0];
  assertExecution(typeof failure === "string");
  for (const marker of [
    "AssertionError: expected",
    "<!-- comment one -->",
    "<!-- comment two -->",
    "html.spec.ts:101:18",
  ]) {
    assertExecution(failure.includes(marker));
  }

  assertExecution(
    skipped.every((value) => {
      const messages = asRecord(value)?.["failureMessages"];
      return Array.isArray(messages) && messages.length === 0;
    }),
  );

  // The default reporter is required because Vitest's JSON reporter omits unhandled errors.
  // One positive marker proves that reporter ran; the structured report above owns the expected
  // assertion details, while the negative markers below reject failures JSON does not expose.
  assertExecution(logs.stderr.includes("Failed Tests 1"));
  for (const marker of [
    "Failed Suites",
    "Unhandled Errors",
    "Unhandled Rejection",
    "Uncaught Exception",
  ]) {
    assertExecution(!logs.stdout.includes(marker) && !logs.stderr.includes(marker));
  }
}

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
 * The shared v1 runner always carries its normalized browser event array. This selected Vitest
 * case owns a nested browser outside that adapter boundary, so its local extension prevents an
 * empty runner array from being misread as a complete browser observation.
 */
export function assertViteUpstreamBrowserObservation(result: unknown): void {
  const record = asRecord(result);
  const browser = asRecord(asRecord(record?.["environment"])?.["browser"]);
  const errors = record?.["browserErrors"];
  const extension = asRecord(asRecord(record?.["extensions"])?.["x-vite-upstream"]);
  if (browser === undefined) {
    throw new Error("the Vite upstream result does not identify its nested browser");
  }
  if (!Array.isArray(errors) || errors.length !== 0) {
    throw new Error("the Vite upstream runner browserErrors field must be an empty v1 array");
  }
  if (extension?.["browserObservation"] !== VITE_UPSTREAM_BROWSER_OBSERVATION) {
    throw new Error(
      "the Vite upstream result must disclose that its nested browser was not runner-observed",
    );
  }
}

/** Add and validate the adapter-owned observation disclosure before publishing a recorded result. */
export function publishViteUpstreamBrowserObservation(
  report: { readonly result: unknown; readonly resultPath: string },
  manifest: unknown,
): Record<string, unknown> {
  const record = asRecord(report.result);
  if (record === undefined) throw new Error("the Vite upstream recorder produced no result object");
  const extensions = asRecord(record["extensions"]) ?? {};
  const adapter = asRecord(extensions["x-vite-upstream"]) ?? {};
  const result = {
    ...record,
    extensions: {
      ...extensions,
      "x-vite-upstream": {
        ...adapter,
        browserObservation: VITE_UPSTREAM_BROWSER_OBSERVATION,
      },
    },
  };
  assertViteUpstreamBrowserObservation(result);
  const validation = createContractValidators().validateResultAgainstManifest(manifest, result);
  if (!validation.valid) {
    throw new Error(
      `the Vite upstream observation disclosure violates the contract:\n${validation.violations
        .map((violation) => violation.message)
        .join("\n")}`,
    );
  }
  writeFileSync(report.resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
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

export function manifestForRsviteHtmlPreserveComments(
  manifest: unknown = readCorpusManifest(),
  options: {
    readonly playwrightModule?: string;
    readonly upstreamRoot?: string;
    readonly viteCheckout?: string;
    readonly vitestExecutable?: string;
  } = {},
): unknown {
  const document = asRecord(manifest);
  const entries = document?.["entries"];
  if (!Array.isArray(entries)) throw new Error("the corpus manifest has no entries");

  return {
    ...document,
    entries: entries.map((value) => {
      const entry = asRecord(value);
      if (entry?.["id"] !== HTML_PRESERVE_COMMENTS_ENTRY_ID) return value;
      const commands = asRecord(entry["commands"]);
      return {
        ...entry,
        commands: {
          ...commands,
          test: {
            argv: [
              options.vitestExecutable ?? workspaceVitestInstallation().executable,
              "run",
              "--config",
              rsviteUpstreamConfigPath,
            ],
            env: {
              NO_COLOR: "1",
              ...(options.playwrightModule === undefined
                ? {}
                : { RSVITE_PLAYWRIGHT_MODULE: options.playwrightModule }),
              ...(options.upstreamRoot === undefined
                ? {}
                : { RSVITE_UPSTREAM_ROOT: options.upstreamRoot }),
              ...(options.viteCheckout === undefined
                ? {}
                : { RSVITE_VITE_CHECKOUT: options.viteCheckout }),
            },
          },
        },
      };
    }),
  };
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

export function htmlPreserveCommentsCommandArgv(
  commandName: "install" | "test",
  manifest: unknown = readCorpusManifest(),
): string[] {
  const raw = asRecord(asRecord(htmlPreserveCommentsEntry(manifest)["commands"])?.[commandName])?.[
    "argv"
  ];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`commands.${commandName}.argv is missing`);
  }
  return raw.map((part, index) => {
    if (typeof part !== "string" || part.length === 0) {
      throw new Error(`commands.${commandName}.argv[${String(index)}] is missing`);
    }
    return part;
  });
}

export function htmlPreserveCommentsCommandExecutable(
  commandName: "install" | "test",
  manifest: unknown = readCorpusManifest(),
): string {
  return htmlPreserveCommentsCommandArgv(commandName, manifest)[0]!;
}

export const VITE_NODE_BUNDLE = "packages/vite/dist/node/index.js";

export function viteNodeBundlePath(checkout: string): string {
  return join(checkout, ...VITE_NODE_BUNDLE.split("/"));
}

export function wipeViteDist(checkout: string): void {
  rmSync(join(checkout, "packages/vite/dist"), { recursive: true, force: true });
}

export function assertViteNodeBundle(checkout: string): void {
  const bundle = viteNodeBundlePath(checkout);
  let stat;
  try {
    stat = statSync(bundle);
  } catch {
    throw new Error(`Vite node bundle is missing: ${VITE_NODE_BUNDLE}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Vite node bundle is not a file: ${VITE_NODE_BUNDLE}`);
  }
}

/** Install deps, discard any existing dist, then build `packages/vite` so test-serve can load it. */
export function preparePinnedViteCheckout(checkout: string): void {
  preparePinnedViteDependencies(checkout);
  wipeViteDist(checkout);
  execFileSync("pnpm", ["--filter", "vite", "build"], { cwd: checkout, encoding: "utf8" });
  assertViteNodeBundle(checkout);
}

export function preparePinnedViteDependencies(checkout: string): void {
  const install = htmlPreserveCommentsCommandArgv("install");
  execFileSync(install[0]!, install.slice(1), { cwd: checkout, encoding: "utf8" });
}

export function vitePlaywrightChromiumModule(checkout: string): string {
  return createRequire(join(checkout, "package.json")).resolve("playwright-chromium");
}

export async function readViteChromiumVersion(checkout: string): Promise<string> {
  const modulePath = vitePlaywrightChromiumModule(checkout);
  const imported = (await import(pathToFileURL(modulePath).href)) as {
    default?: unknown;
    chromium?: unknown;
  };
  const playwright = (imported.chromium === undefined ? imported.default : imported) as {
    chromium: {
      launch(options: { headless: boolean }): Promise<{
        version(): string;
        close(): Promise<void>;
      }>;
    };
  };
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
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
