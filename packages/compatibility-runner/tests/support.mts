import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeclaredRunInputs, RunEnvironment, RunRequest } from "../src/index.ts";

export const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

/**
 * The synthetic corpus entry. Its provenance points at a real pinned source so the fixture is
 * shape-valid the way a real entry is; the commands run this package's own scripts, because the
 * point is to exercise orchestration rather than to validate any project.
 */
export function syntheticManifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    contractVersion: 1,
    entries: [
      {
        id: "synthetic-orchestration",
        kind: "real-project",
        source: {
          repository: "https://github.com/vitejs/vite",
          commit: "ee644014aab61e546742b862a7d7b0d6c7d67a7b",
          license: { spdxId: "MIT", path: "LICENSE" },
        },
        lockfile: { path: "pnpm-lock.yaml", packageManager: { name: "pnpm", version: "11.20.0" } },
        commands: {
          install: { argv: [process.execPath, join(fixturesDir, "exit.mjs")] },
          dev: { argv: [process.execPath, join(fixturesDir, "serve.mjs")] },
          build: { argv: [process.execPath, join(fixturesDir, "exit.mjs")] },
          preview: { argv: [process.execPath, join(fixturesDir, "serve.mjs")] },
        },
        readiness: { type: "http-ready", urlPath: "/", expectStatus: 200, timeoutMs: 10_000 },
        browserAcceptance: {
          entryPath: "/",
          mainFrameNavigationIsFailure: true,
          hmr: {
            sentinelExpression: "globalThis.__rsviteHmrSentinel",
            sentinelStorage: "in-memory",
            edit: { path: "index.html", find: "served", replace: "served again" },
            expectedText: "served again",
          },
        },
        expectedCapabilities: ["html"],
        javascriptApiLevel: "C0",
        notes:
          "Fixture for the runner's orchestration tests. It is not part of the adopted corpus.",
        ...overrides,
      },
    ],
  };
}

export const environment: RunEnvironment = {
  os: "linux",
  arch: "x64",
  runnerImage: "local",
  nodeVersion: "24.20.0",
  packageManager: { name: "pnpm", version: "11.20.0" },
};

export function declaredFor(subject: "vite" | "rsvite"): DeclaredRunInputs {
  return {
    javascriptApiLevel: "C0",
    capabilityOwners: [{ capability: "html", owner: subject === "vite" ? "vite" : "rust" }],
    explicitFallbacks: [],
    classifyFailure: (failure) => ({
      kind: "current-compatibility-requirement",
      evidence: `The runner test declares this classification for a ${failure.phase} failure.`,
    }),
  };
}

/** A port nothing is listening on right now, so parallel tests do not collide. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function runDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rsvite-runner-"));
}

export async function baseRequest(
  subject: "vite" | "rsvite",
  overrides: Partial<RunRequest> = {},
): Promise<RunRequest> {
  const port = await freePort();
  return {
    manifest: syntheticManifest(),
    entryId: "synthetic-orchestration",
    lifecycle: "dev",
    subject: { name: subject, version: "0.0.0" },
    environment,
    projectRoot: fixturesDir,
    artifactRoot: await runDir(),
    origin: `http://127.0.0.1:${String(port)}`,
    declared: declaredFor(subject),
    timeouts: { installMs: 10_000, lifecycleMs: 10_000, browserMs: 5_000 },
    ...overrides,
  } as RunRequest;
}

/** Commands read PORT, so the entry does not have to encode a port the test cannot choose. */
export function withPort(
  manifest: unknown,
  port: number,
  extraEnv: Record<string, string> = {},
): unknown {
  const document = structuredClone(manifest) as {
    entries: { commands: Record<string, { argv: string[]; env?: Record<string, string> }> }[];
  };
  const entry = document.entries[0]!;
  for (const name of ["dev", "preview"]) {
    const command = entry.commands[name];
    if (command) command.env = { PORT: String(port), ...extraEnv };
  }
  return document;
}
