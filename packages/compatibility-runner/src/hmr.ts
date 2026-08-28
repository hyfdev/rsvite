import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserPage } from "./browser.ts";

interface HmrEdit {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
}

export interface HmrAcceptance {
  readonly sentinelExpression: string;
  readonly edit: HmrEdit;
  readonly expectedText: string;
}

/**
 * The manifest-declared source change for one HMR update window. The runner owns the file and
 * always restores it; an adapter override owns only the extra project-specific work around the
 * same declared change. `apply()` is revoked when that window closes; `restore()` remains safe for
 * adapter cleanup.
 */
export interface HmrUpdate {
  readonly expectedText: string;
  apply(): Promise<void>;
  restore(): Promise<void>;
}

export interface PreparedHmrUpdate {
  readonly expectedText: string;
  applyWhile(assertAllowed: () => void): Promise<void>;
  restore(): Promise<void>;
  isApplied(): boolean;
  wasApplied(): boolean;
}

interface PreparedEdit {
  readonly sourcePath: string;
  readonly original: string;
  readonly changed: string;
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

/** Creates one stateful edit with idempotent apply and restore operations. */
export function createHmrUpdate(projectRoot: string, acceptance: HmrAcceptance): PreparedHmrUpdate {
  const { edit } = acceptance;
  let prepared: PreparedEdit | undefined;
  let applied = false;
  let everApplied = false;
  let operations = Promise.resolve();

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const next = operations.then(operation, operation);
    operations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function prepare(): Promise<PreparedEdit> {
    if (prepared !== undefined) return prepared;
    if (isAbsolute(edit.path)) {
      throw new Error(`the declared HMR edit path must be relative to the project: ${edit.path}`);
    }

    const root = await realpath(projectRoot);
    const source = await realpath(resolve(root, edit.path));
    if (!isInside(root, source)) {
      throw new Error(`the declared HMR edit escapes the project root: ${edit.path}`);
    }

    const before = await readFile(source, "utf8");
    const offset = before.indexOf(edit.find);
    if (offset === -1) {
      throw new Error(`the declared HMR edit path ${edit.path} does not contain its find text`);
    }
    const after = `${before.slice(0, offset)}${edit.replace}${before.slice(offset + edit.find.length)}`;
    if (after === before) {
      throw new Error(`the declared HMR edit for ${edit.path} does not change the file`);
    }

    prepared = { sourcePath: source, original: before, changed: after };
    return prepared;
  }

  async function restoreNow(): Promise<void> {
    if (!applied) return;
    const editState = await prepare();
    const current = await readFile(editState.sourcePath, "utf8");
    if (current !== editState.original) {
      await writeFile(editState.sourcePath, editState.original, "utf8");
    }
    applied = false;
    if (current !== editState.changed && current !== editState.original) {
      throw new Error(`the declared HMR edit path ${edit.path} changed again before restoration`);
    }
  }

  function restore(): Promise<void> {
    return enqueue(restoreNow);
  }

  return {
    expectedText: acceptance.expectedText,
    applyWhile(assertAllowed: () => void): Promise<void> {
      return enqueue(async () => {
        assertAllowed();
        if (applied) return;
        const editState = await prepare();
        assertAllowed();
        // If the write or the second permission check fails after changing the file, this call
        // restores the original content even when the runner has left the update window.
        applied = true;
        try {
          await writeFile(editState.sourcePath, editState.changed, "utf8");
          everApplied = true;
          assertAllowed();
        } catch (error) {
          await restoreNow();
          throw error;
        }
      });
    },
    restore,
    isApplied: () => applied,
    wasApplied: () => everApplied,
  };
}

function expectedTextExpression(text: string): string {
  return `Boolean(document.body?.innerText.includes(${JSON.stringify(text)}))`;
}

export async function pageHasExpectedText(
  page: BrowserPage,
  signal: AbortSignal,
  text: string,
): Promise<boolean> {
  return (await page.evaluate(expectedTextExpression(text), signal)) === true;
}

/**
 * The default update is intentionally narrow: it proves one page-text transition caused by the
 * declared file edit. An adapter overrides it when the expected text is already present or the
 * project needs a stronger signal such as a stylesheet update frame.
 */
export async function runDefaultHmrUpdate(
  page: BrowserPage,
  signal: AbortSignal,
  update: HmrUpdate,
): Promise<void> {
  if (await pageHasExpectedText(page, signal, update.expectedText)) {
    throw new Error(
      `the declared HMR expectedText ${JSON.stringify(update.expectedText)} was already present before the edit; provide an adapter update override with a project-specific signal`,
    );
  }

  await update.apply();
  for (;;) {
    if (await pageHasExpectedText(page, signal, update.expectedText)) return;
    await delay(100, undefined, { signal });
  }
}
