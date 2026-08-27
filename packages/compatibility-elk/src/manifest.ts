import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeclaredRunInputs, LifecycleName } from "@rsvite/compatibility-runner";

export const ELK_ENTRY_ID = "elk";
export const ELK_REPOSITORY = "https://github.com/elk-zone/elk";
export const ELK_COMMIT = "ae4ebf3375eb68f1f355390b4f163adb10f5026c";
export const ELK_LICENSE_PATH = "LICENSE";
export const ELK_LOCKFILE = "pnpm-lock.yaml";
export const ELK_PNPM_VERSION = "11.6.0";
export const ELK_HOME_PATH = "/home";
export const ELK_SENTINEL = "globalThis.__rsviteElkHmrSentinel";
export const ELK_HMR_STYLESHEET = "app/styles/global.css";

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(srcDir, "..");
const repoRoot = join(packageDir, "../..");

export const corpusManifestPath = join(repoRoot, "corpus/manifest.json");
export const elkLicensePath = join(repoRoot, "corpus/elk/LICENSE");
export const elkEvidenceRoot = join(repoRoot, "corpus/results/elk");
export const elkEvidenceResultPaths = {
  vite: {
    dev: join(elkEvidenceRoot, "vite/dev/result.json"),
    build: join(elkEvidenceRoot, "vite/build/result.json"),
    preview: join(elkEvidenceRoot, "vite/preview/result.json"),
  },
  rsvite: {
    dev: join(elkEvidenceRoot, "rsvite/dev/result.json"),
  },
} as const;

export type ElkSubject = "vite" | "rsvite";

export interface ElkManifestOptions {
  readonly lifecycle: LifecycleName;
  readonly pnpmVersion: string;
  readonly port: number;
  readonly subject: ElkSubject;
  readonly rsviteCommand?: readonly string[];
}

const DEV_CAPABILITIES = [
  "html",
  "modules-and-assets",
  "resolution",
  "errors",
  "file-watching",
  "hmr-without-full-reload",
  "ssr",
  "framework-lifecycle",
] as const;
const BUILD_CAPABILITIES = ["build-output", "ssr", "framework-lifecycle"] as const;
const PREVIEW_CAPABILITIES = [
  "html",
  "modules-and-assets",
  "preview-output",
  "ssr",
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

export function elkEntryFromManifest(
  manifest: unknown = readCorpusManifest(),
): Record<string, unknown> {
  const entries = asRecord(manifest)?.["entries"];
  if (!Array.isArray(entries)) throw new Error("the corpus manifest has no entries");
  const entry = asRecord(entries.find((candidate) => asRecord(candidate)?.["id"] === ELK_ENTRY_ID));
  if (entry === undefined) throw new Error(`the corpus manifest has no entry ${ELK_ENTRY_ID}`);
  return entry;
}

function commandFor(
  subject: ElkSubject,
  lifecycle: LifecycleName,
  port: number,
  rsviteCommand: readonly string[] | undefined,
): { argv: string[]; env?: Record<string, string> } {
  const mocked = { CONTEXT: "dev" };
  if (subject === "vite") {
    switch (lifecycle) {
      case "dev":
        return {
          argv: [
            "pnpm",
            "exec",
            "nuxt",
            "dev",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--dotenv",
            ".env.mock",
          ],
          env: mocked,
        };
      case "build":
        return { argv: ["pnpm", "build"], env: mocked };
      case "preview":
        return {
          argv: ["node", ".output/server/index.mjs"],
          env: { ...mocked, PORT: String(port), HOST: "127.0.0.1" },
        };
      case "test":
        throw new Error("ELK has no adopted test lifecycle in the compatibility corpus");
    }
  }

  const command = rsviteCommand ?? ["npx", "--no-install", "rsvite"];
  switch (lifecycle) {
    case "dev":
      return { argv: [...command, ".", "--port", String(port)], env: mocked };
    case "build":
      return { argv: [...command, "build", "."], env: mocked };
    case "preview":
      return {
        argv: [...command, "preview", ".", "--port", String(port)],
        env: mocked,
      };
    case "test":
      throw new Error("ELK has no adopted test lifecycle in the compatibility corpus");
  }
}

function readinessFor(lifecycle: LifecycleName): Record<string, unknown> {
  if (lifecycle === "build") return { type: "process-exit", timeoutMs: 900_000 };
  return {
    type: "http-ready",
    urlPath: lifecycle === "preview" ? "/" : ELK_HOME_PATH,
    expectStatus: 200,
    timeoutMs: 180_000,
  };
}

function browserAcceptanceFor(lifecycle: LifecycleName): Record<string, unknown> {
  return {
    entryPath: lifecycle === "preview" ? "/" : ELK_HOME_PATH,
    mainFrameNavigationIsFailure: true,
    hmr: {
      sentinelExpression: ELK_SENTINEL,
      sentinelStorage: "in-memory",
      edit: {
        path: ELK_HMR_STYLESHEET,
        find: "unused-elk-hmr-marker",
        replace: "unused-elk-hmr-marker",
      },
      expectedText: "elkdev",
    },
  };
}

export function createElkManifest(options: ElkManifestOptions): unknown {
  const manifest = structuredClone(readCorpusManifest()) as Record<string, unknown>;
  const entry = elkEntryFromManifest(manifest);
  const lockfile = asRecord(entry["lockfile"]);
  const packageManager = asRecord(lockfile?.["packageManager"]);
  if (packageManager?.["name"] !== "pnpm") {
    throw new Error("the ELK corpus entry must use pnpm");
  }
  packageManager["version"] = options.pnpmVersion;

  const install = { argv: ["pnpm", "install", "--frozen-lockfile"] };
  const dev = commandFor(options.subject, "dev", options.port, options.rsviteCommand);
  const build = commandFor(options.subject, "build", options.port, options.rsviteCommand);
  const preview = commandFor(options.subject, "preview", options.port, options.rsviteCommand);
  entry["commands"] = { install, dev, build, preview };
  entry["readiness"] = readinessFor(options.lifecycle);
  entry["browserAcceptance"] = browserAcceptanceFor(options.lifecycle);
  return manifest;
}

function capabilitiesFor(lifecycle: LifecycleName): readonly string[] {
  switch (lifecycle) {
    case "dev":
      return DEV_CAPABILITIES;
    case "build":
      return BUILD_CAPABILITIES;
    case "preview":
      return PREVIEW_CAPABILITIES;
    case "test":
      throw new Error("ELK has no adopted test lifecycle in the compatibility corpus");
  }
}

export function declaredElkRun(subject: ElkSubject, lifecycle: LifecycleName): DeclaredRunInputs {
  const owner = subject === "vite" ? "vite" : "rust";
  return {
    javascriptApiLevel: subject === "vite" ? "C3" : "C0",
    capabilityOwners: capabilitiesFor(lifecycle).map((capability) => ({ capability, owner })),
    explicitFallbacks: [],
    classifyFailure: (failure) => ({
      kind: "current-compatibility-requirement",
      evidence:
        subject === "vite"
          ? `The pinned ELK Vite baseline failed during ${failure.phase}: ${failure.message}`
          : `rsvite failed during ${failure.phase} before ELK could exercise the selected ${lifecycle} capabilities: ${failure.message}`,
    }),
  };
}
