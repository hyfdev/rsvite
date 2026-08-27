import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runUpstreamOrThrow } from "./upstream.ts";
import { assertPinnedCheckout, readPin, type CheckoutProblem, type Pin } from "./index.ts";

/**
 * The branch the pinned revision is parked on.
 *
 * The project's own build script runs `git pull` in this checkout. On a detached head that fails
 * and takes the build with it, and against the real remote it silently moves the input forward.
 * Parking the pin on a branch whose upstream is this same repository makes that `git pull` a
 * no-op — the project's command runs exactly as written, and cannot change what it reads.
 */
const PINNED_BRANCH = "rsvite-pinned";

const CLONE_MS = 600_000;
const GIT_MS = 300_000;

function step(label: string, dir: string, args: readonly string[]) {
  return { label, command: { argv: ["git", "-C", dir, ...args] }, timeoutMs: GIT_MS };
}

export function translationsRoot(root: string, pin: Pin = readPin()): string {
  return join(root, pin.translations.path);
}

/**
 * Actual Budget's production build clones `actualbudget/translations` into the checkout, pulls it,
 * and prunes the languages it does not want. The directory is ignored by the project's own
 * `.gitignore`, so an ordinary status of the outer checkout cannot see it — yet the application
 * compiles its JSON into the bundle. Without pinning it, the recorded commit and lockfile do not
 * determine what was built.
 */
export function inspectTranslations(root: string, pin: Pin = readPin()): CheckoutProblem[] {
  const dir = translationsRoot(root, pin);
  if (!existsSync(join(dir, ".git"))) {
    return [
      {
        kind: "missing",
        detail: `${pin.translations.path} is not a git checkout, so the build would clone a moving one`,
      },
    ];
  }

  const problems: CheckoutProblem[] = [];
  const head = gitOutput(dir, ["rev-parse", "HEAD"]);
  if (head !== pin.translations.commit) {
    problems.push({
      kind: "wrong-commit",
      detail: `the translations checkout is at ${head}, but the corpus pins ${pin.translations.commit}`,
    });
  }
  // Ignored files count. This repository ignores `source.json`, the application imports every
  // `locale/*.json`, and the project's own prune leaves ignored files alone — so a file git is
  // told not to mention is still compiled into the bundle. Anything here that the pinned tree
  // does not contain is an undeclared build input.
  const dirty = gitOutput(dir, ["status", "--porcelain", "--untracked-files=all", "--ignored"]);
  if (dirty !== "") {
    problems.push({
      kind: "modified",
      detail: `the translations checkout is not the pinned tree: ${dirty.split("\n").slice(0, 3).join("; ")}`,
    });
  }
  return problems;
}

export function assertPinnedTranslations(root: string, pin: Pin = readPin()): void {
  const problems = inspectTranslations(root, pin);
  if (problems.length === 0) return;
  throw new Error(
    `the translations the build reads are not the pinned ones:\n${problems
      .map((problem) => `- ${problem.detail}`)
      .join("\n")}`,
  );
}

/**
 * Puts the pinned revision in place and makes it stay there, then proves it. Also the restore
 * path: the build prunes languages, so the same operation returns the checkout to the pin.
 */
/**
 * Everything a recording of this entry holds fixed: the project's own checkout, and the input its
 * build reads from inside that checkout but outside its history. Both, always — checking only the
 * one git can see reports a reproducible run that is not one.
 */
export function assertPinnedInputs(root: string, pin: Pin = readPin()): void {
  assertPinnedCheckout(root, pin);
  assertPinnedTranslations(root, pin);
}

export async function prepareTranslations(
  root: string,
  pin: Pin = readPin(),
  signal?: AbortSignal,
): Promise<void> {
  const dir = translationsRoot(root, pin);
  if (!existsSync(join(dir, ".git"))) {
    await runUpstreamOrThrow(
      {
        label: "cloning the pinned translations",
        command: { argv: ["git", "clone", pin.translations.repository, dir] },
        timeoutMs: CLONE_MS,
      },
      signal,
    );
  }

  // Only when the pinned revision is not already here: restoring the checkout after a build must
  // not depend on the network, and must not be able to bring anything new in.
  if (!hasCommit(dir, pin.translations.commit)) {
    await runUpstreamOrThrow(
      step("fetching the pinned translations", dir, ["fetch", "origin"]),
      signal,
    );
  }
  await runUpstreamOrThrow(
    step("parking the translations on the pin", dir, [
      "checkout",
      "--force",
      "-B",
      PINNED_BRANCH,
      pin.translations.commit,
    ]),
    signal,
  );
  // `-x` as well: without it an ignored file survives every clean, every prune and every
  // ordinary status, and goes on being compiled into the bundle no run ever declared.
  await runUpstreamOrThrow(
    step("clearing the translations checkout", dir, ["clean", "-fdx"]),
    signal,
  );
  for (const [key, value] of [
    [`branch.${PINNED_BRANCH}.remote`, "."],
    [`branch.${PINNED_BRANCH}.merge`, `refs/heads/${PINNED_BRANCH}`],
  ]) {
    await runUpstreamOrThrow(
      step("pointing the translations upstream at itself", dir, [
        "config",
        key as string,
        value as string,
      ]),
      signal,
    );
  }

  assertPinnedTranslations(root, pin);
}

function hasCommit(dir: string, commit: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitOutput(dir: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}
