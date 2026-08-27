import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandSpec, DeclaredRunInputs } from "@rsvite/compatibility-runner";
import { SENTINEL_EXPRESSION } from "./browser.ts";

/** The pinned identity of the validated project, kept out of code so a change is reviewable. */
export interface Pin {
  readonly repository: string;
  readonly commit: string;
  readonly license: { readonly spdxId: string; readonly path: string };
  readonly lockfile: {
    readonly path: string;
    readonly packageManager: { readonly name: string; readonly version: string };
  };
  readonly entryId: string;
  readonly e2eSpec: string;
  readonly devPort: number;
  readonly sentinelEditPath: string;
  readonly sentinelEdit: {
    readonly find: string;
    readonly replace: string;
    readonly expectedText: string;
  };
}

const pinPath = fileURLToPath(new URL("../pin.json", import.meta.url));

export function readPin(): Pin {
  return JSON.parse(readFileSync(pinPath, "utf8")) as Pin;
}

export interface CheckoutProblem {
  readonly kind: "wrong-commit" | "modified" | "missing";
  readonly detail: string;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

/**
 * A checkout is only evidence if it is the pinned one and nobody has touched it. The project's
 * own source, tests and lockfile are the thing being measured; a local edit would make the run
 * describe something that exists nowhere else, and "it passed here" would mean nothing.
 */
export function inspectCheckout(root: string, pin: Pin = readPin()): CheckoutProblem[] {
  if (!existsSync(join(root, ".git"))) {
    return [{ kind: "missing", detail: `${root} is not a git checkout` }];
  }

  const problems: CheckoutProblem[] = [];
  const head = git(root, ["rev-parse", "HEAD"]);
  if (head !== pin.commit) {
    problems.push({
      kind: "wrong-commit",
      detail: `checkout is at ${head}, but the corpus pins ${pin.commit}`,
    });
  }

  // Everything, not just tracked source: an untracked file inside the project can change what a
  // build or a test sees just as effectively as an edit.
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty !== "") {
    const first = dirty.split("\n").slice(0, 3).join("; ");
    problems.push({ kind: "modified", detail: `the checkout has local changes: ${first}` });
  }

  for (const path of [pin.license.path, pin.lockfile.path, pin.e2eSpec]) {
    if (!existsSync(join(root, path))) {
      problems.push({ kind: "missing", detail: `${path} is missing from the checkout` });
    }
  }

  return problems;
}

export function assertPinnedCheckout(root: string, pin: Pin = readPin()): void {
  const problems = inspectCheckout(root, pin);
  if (problems.length === 0) return;
  throw new Error(
    `the Actual Budget checkout cannot be used as evidence:\n${problems
      .map((problem) => `- ${problem.detail}`)
      .join("\n")}`,
  );
}

/**
 * The project's own lifecycle commands, unchanged. `install` is immutable so a run can never
 * quietly resolve a different dependency graph than the lockfile records.
 */
export function actualBudgetCommands(pin: Pin = readPin()): Record<string, CommandSpec> {
  const env = { BROWSER: "none", PORT: String(pin.devPort) };
  return {
    install: { argv: ["corepack", "yarn", "install", "--immutable"] },
    // The project's own development entry, the same one its Playwright configuration starts.
    dev: { argv: ["corepack", "yarn", "start"], env },
    build: { argv: ["corepack", "yarn", "build:browser"] },
    preview: { argv: ["node", "packages/desktop-client/bin/serve-build.mjs"], env },
  };
}

/** The corpus entry, generated from the pin so the manifest cannot drift away from it. */
export function actualBudgetEntry(pin: Pin = readPin()): Record<string, unknown> {
  return {
    id: pin.entryId,
    kind: "real-project",
    source: { repository: pin.repository, commit: pin.commit, license: pin.license },
    lockfile: pin.lockfile,
    commands: actualBudgetCommands(pin),
    readiness: { type: "http-ready", urlPath: "/", expectStatus: 200, timeoutMs: 300000 },
    browserAcceptance: {
      entryPath: "/",
      mainFrameNavigationIsFailure: true,
      hmr: {
        sentinelExpression: SENTINEL_EXPRESSION,
        sentinelStorage: "in-memory",
        edit: {
          path: pin.sentinelEditPath,
          find: pin.sentinelEdit.find,
          replace: pin.sentinelEdit.replace,
        },
        expectedText: pin.sentinelEdit.expectedText,
      },
    },
    expectedCapabilities: [
      "html",
      "modules-and-assets",
      "resolution",
      "file-watching",
      "hmr-without-full-reload",
      "build-output",
    ],
    javascriptApiLevel: "C1",
    notes:
      "Complex React monorepo gate. The adapter drives the project's own onboarding E2E spec and build without modifying its source or expectations.",
  };
}

/**
 * Actual Budget's Playwright configuration skips starting its own server when `E2E_START_URL`
 * is set. That is the seam this adapter uses: the runner owns the server and its readiness, and
 * the project's spec files stay exactly as upstream wrote them.
 */
export function devOrigin(pin: Pin = readPin()): string {
  return `http://localhost:${String(pin.devPort)}`;
}

export function upstreamE2eCommand(origin: string, pin: Pin = readPin()): CommandSpec {
  return {
    argv: [
      "corepack",
      "yarn",
      "workspace",
      "@actual-app/web",
      "playwright",
      "test",
      pin.e2eSpec.replace("packages/desktop-client/", ""),
      "--browser=chromium",
      "--workers=1",
      "--retries=0",
    ],
    env: { E2E_START_URL: origin, CI: "1" },
  };
}

/**
 * The same input, driven by rsvite instead of by the project's own toolchain.
 *
 * Installing is the project's own install: substituting the bundler does not change the
 * dependencies of the thing being measured. The development command is rsvite's Vite-compatible
 * entry point as this workspace would publish it — running the project is exactly what a
 * drop-in replacement has to be able to do, so that is what the corpus attempts and records,
 * whether or not the entry point exists yet.
 */
export function rsviteCommands(
  repoRoot: string,
  pin: Pin = readPin(),
): Record<string, CommandSpec> {
  const rsvite = join(repoRoot, "node_modules/.bin/rsvite");
  return {
    install: { argv: ["corepack", "yarn", "install", "--immutable"] },
    dev: { argv: [rsvite, "dev", "--port", String(pin.devPort)], env: { BROWSER: "none" } },
    build: { argv: [rsvite, "build"] },
    preview: { argv: [rsvite, "preview", "--port", String(pin.devPort)], env: { BROWSER: "none" } },
  };
}

/**
 * What the Vite baseline sets out to show. Vite owns every capability it demonstrates and has
 * nothing to fall back to, so a baseline failure is a statement about the input rather than
 * about an implementation gap: it means the corpus entry itself cannot be used as a gate.
 */
export function viteDeclaration(): DeclaredRunInputs {
  return {
    javascriptApiLevel: "C1",
    capabilityOwners: [
      "html",
      "modules-and-assets",
      "resolution",
      "file-watching",
      "hmr-without-full-reload",
    ].map((capability) => ({ capability, owner: "vite" })),
    explicitFallbacks: [],
    classifyFailure: (failure) => ({
      kind: "current-compatibility-requirement",
      evidence: `The original Vite baseline failed during ${failure.phase}, so the input itself is not usable as a gate until this is understood.`,
    }),
  };
}

/**
 * What an rsvite run sets out to obtain from rsvite, and from which side of it.
 *
 * Only the first thing the development lifecycle needs is declared. Serving the project entry is
 * what a run has to get past before any later capability is even attempted, so claiming the rest
 * would put expectations in the record that this run was never in a position to test. Nothing is
 * carried by compatibility JavaScript: the point of the entry is what the Rust core can do with
 * the project as it stands.
 */
export function rsviteDeclaration(): DeclaredRunInputs {
  return {
    javascriptApiLevel: "C0",
    capabilityOwners: [{ capability: "html", owner: "rust" }],
    explicitFallbacks: [],
    classifyFailure: (failure) => ({
      kind: "current-compatibility-requirement",
      evidence: `Actual Budget is a current compatibility requirement, and rsvite diverges from the Vite baseline recorded beside this result at ${failure.phase}, which is the first lifecycle step the project needs.`,
    }),
  };
}
