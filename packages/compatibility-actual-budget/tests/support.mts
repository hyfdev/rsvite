import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunReport, RunRequest } from "@rsvite/compatibility-runner";
import type { Pin } from "../src/index.ts";

export interface StubOptions {
  readonly redirectOnArrival?: boolean;
  readonly neverSettles?: boolean;
  readonly failAfterLaunch?: boolean;
  readonly launchDelayMs?: number;
  readonly browserVersion?: string;
  /** Which post-launch setup step never settles. */
  readonly hangIn?: "newContext" | "addInitScript" | "newPage";
}

export interface StubCheckout {
  readonly root: string;
  launched(): number;
  closed(): number;
  contextStarted(): number;
  /** The page the stand-in last handed out, for driving events after arrival. */
  page(): { navigate(to: string): void };
}

/**
 * A checkout whose `node_modules/playwright` is the stand-in. Each one is its own directory, so
 * one test's configuration and counters cannot reach another's.
 */
export function stubCheckout(options: StubOptions = {}): StubCheckout {
  const root = mkdtempSync(join(tmpdir(), "ab-stub-"));
  const target = join(root, "node_modules/playwright");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(root, "package.json"), `{"name":"stub-checkout","version":"0.0.0"}\n`);
  writeFileSync(
    join(target, "package.json"),
    `{"name":"playwright","version":"0.0.0","main":"index.cjs"}\n`,
  );
  cpSync(
    fileURLToPath(new URL("./fixtures/stub-playwright.cjs", import.meta.url)),
    join(target, "index.cjs"),
  );
  writeFileSync(join(target, "stub-config.json"), JSON.stringify(options));

  const statePath = join(target, "stub-state.json");
  const read = (key: "launched" | "closed" | "contextStarted"): number => {
    if (!existsSync(statePath)) return 0;
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, number>;
    return state[key] ?? 0;
  };

  return {
    root,
    launched: () => read("launched"),
    closed: () => read("closed"),
    contextStarted: () => read("contextStarted"),
    page: () =>
      (
        createRequire(join(root, "package.json"))("playwright") as {
          __lastPage(): { navigate(to: string): void };
        }
      ).__lastPage(),
  };
}

/** Lets a scheduled callback run without asserting anything about how long it takes. */
export function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A real git checkout that satisfies a pin, so the recorder's own checks run against git rather
 * than against a description of it. The pin points at whatever this checkout committed.
 */
export function pinnedCheckout(): {
  root: string;
  pin: Pin;
  write(path: string, body: string): void;
} {
  const root = mkdtempSync(join(tmpdir(), "ab-pinned-"));
  const write = (path: string, body: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };

  write("LICENSE.txt", "MIT\n");
  write("yarn.lock", "# lock\n");
  write("packages/desktop-client/e2e/onboarding.test.ts", "// upstream spec\n");
  write(
    "packages/desktop-client/src/components/manager/WelcomeScreen.tsx",
    "<Trans>Welcome</Trans>\n",
  );
  // Ignored by the project exactly as upstream ignores its translations checkout, which is what
  // makes an ordinary status of the outer checkout unable to see it.
  write(".gitignore", "ignored/\npackages/desktop-client/locale\n");

  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.email", "recorder@example.invalid");
  git("config", "user.name", "recorder");
  git("add", "--all");
  git("commit", "--quiet", "--message", "pinned");

  // A second input the build reads, living inside the checkout but outside its history.
  const localePath = "packages/desktop-client/locale";
  write(join(localePath, "en.json"), `{"welcome":"Welcome"}\n`);
  const locale = (...args: string[]): string =>
    execFileSync("git", ["-C", join(root, localePath), ...args], { encoding: "utf8" }).trim();
  locale("init", "--quiet");
  locale("config", "user.email", "recorder@example.invalid");
  locale("config", "user.name", "recorder");
  locale("add", "--all");
  locale("commit", "--quiet", "--message", "translations");

  const pin: Pin = {
    repository: "https://example.invalid/actual",
    commit: git("rev-parse", "HEAD"),
    license: { spdxId: "MIT", path: "LICENSE.txt" },
    lockfile: { path: "yarn.lock", packageManager: { name: "yarn", version: "4.17.1" } },
    entryId: "actual-budget",
    e2eSpec: "packages/desktop-client/e2e/onboarding.test.ts",
    devPort: 3001,
    sentinelEditPath: "packages/desktop-client/src/components/manager/WelcomeScreen.tsx",
    sentinelEdit: { find: "Welcome", replace: "Welcome (probe)", expectedText: "Welcome (probe)" },
    translations: {
      repository: "https://example.invalid/translations",
      commit: locale("rev-parse", "HEAD"),
      path: localePath,
    },
  };
  return { root, pin, write };
}

/** A check that records `outcome` without running anything, for testing what surrounds it. */
export function recordingCheck(outcome: "pass" | "fail"): {
  check: (request: RunRequest) => Promise<RunReport>;
  calls(): number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    check: async (request) => {
      calls += 1;
      const resultPath = join(request.artifactRoot, "result.json");
      mkdirSync(request.artifactRoot, { recursive: true });
      writeFileSync(resultPath, JSON.stringify({ outcome }, null, 2));
      const logs = {
        install: { stdout: "install.stdout.log", stderr: "install.stderr.log" },
        lifecycle: { stdout: "dev.stdout.log", stderr: "dev.stderr.log" },
      };
      const report = { result: { outcome }, resultPath, logs };
      return outcome === "pass"
        ? report
        : { ...report, failure: { phase: "dev" as const, message: "it did not start" } };
    },
  };
}
