import { createRequire } from "node:module";
import { join } from "node:path";
import type { BrowserAdapter, BrowserEvent, BrowserPage } from "@rsvite/compatibility-runner";

/**
 * The sentinel is installed by the browser, not by the project. Every new document gets a fresh
 * value, so it survives an update that patches the running document and is lost by anything
 * that replaces it. It lives only in `globalThis`: a value restored from IndexedDB or
 * localStorage would survive a full reload too, and would prove nothing.
 */
export const SENTINEL_EXPRESSION = "globalThis.__rsviteHmrSentinel";

const INIT_SCRIPT = `globalThis.__rsviteHmrSentinel = Math.random().toString(36).slice(2);`;

/**
 * How many consecutive observations of an unchanged address end the arrival phase, and how many
 * observations may pass before the page is declared never to have settled. Counting observations
 * rather than elapsed time is what the behaviour actually depends on — it does not care how fast
 * the polls happen — and it is what lets the condition be tested without wall-clock sleeps.
 */
export const SETTLE_QUIET_OBSERVATIONS = 15;
export const SETTLE_MAX_OBSERVATIONS = 300;
const OBSERVATION_INTERVAL_MS = 100;

interface PlaywrightModule {
  chromium: {
    launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
    executablePath?(): string;
  };
}

interface PlaywrightBrowser {
  version(): string;
  newContext(): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightContext {
  addInitScript(script: string): Promise<void>;
  newPage(): Promise<PlaywrightPage>;
}

interface PlaywrightPage {
  on(event: string, handler: (payload: never) => void): void;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  mainFrame(): unknown;
  url(): string;
}

/**
 * Playwright is taken from the pinned checkout rather than added to this repository. The project
 * already pins the version its own tests run under, and measuring it with a different one would
 * make the browser part of the difference being measured.
 */
export function loadPlaywright(checkoutRoot: string): PlaywrightModule {
  const require = createRequire(join(checkoutRoot, "package.json"));
  return require("playwright") as PlaywrightModule;
}

/** The version of the browser that will actually run, not of the library that launches it. */
export async function readBrowserVersion(checkoutRoot: string): Promise<string> {
  const browser = await loadPlaywright(checkoutRoot).chromium.launch({ headless: true });
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}

export interface Observable {
  url(): string;
}

export interface SettleLimits {
  readonly quietObservations?: number;
  readonly maxObservations?: number;
  readonly intervalMs?: number;
}

/**
 * Resolves once the address has been unchanged for a run of consecutive observations.
 *
 * An application decides where it belongs after it loads, and a redirect to its own entry route
 * is part of arriving rather than evidence about an update that has not happened yet. Without
 * this wait the startup redirect lands inside the update window and is read as a full reload.
 *
 * A page that never settles raises. Falling through as success would open the update window over
 * an application that was still moving, and every navigation it then made would be read as a
 * reload — a silent timeout is how that becomes indistinguishable from a real failure.
 */
export async function settle(page: Observable, limits: SettleLimits = {}): Promise<void> {
  const quiet = limits.quietObservations ?? SETTLE_QUIET_OBSERVATIONS;
  const max = limits.maxObservations ?? SETTLE_MAX_OBSERVATIONS;
  const intervalMs = limits.intervalMs ?? OBSERVATION_INTERVAL_MS;

  let seen = page.url();
  let unchanged = 0;
  for (let observation = 0; observation < max; observation += 1) {
    if (intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const now = page.url();
    if (now === seen) {
      unchanged += 1;
      if (unchanged >= quiet) return;
      continue;
    }
    seen = now;
    unchanged = 0;
  }
  throw new Error(
    `the page was still moving after ${String(max)} observations; it never finished arriving`,
  );
}

/**
 * Settles as soon as the runner gives up, as the adapter contract requires — and hands back
 * whatever the abandoned work produced, so the caller can release it. Rejecting alone would
 * leave a browser that finished launching after the abort running with nobody holding it.
 */
function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
  what: string,
  release: (value: T) => Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      void work.then(
        (value) => release(value).catch(() => undefined),
        () => undefined,
      );
      reject(new Error(`${what} was aborted`));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error as Error);
      },
    );
  });
}

const nothingToRelease = (): Promise<void> => Promise.resolve();

export function createPlaywrightBrowser(checkoutRoot: string): BrowserAdapter {
  const playwright = loadPlaywright(checkoutRoot);

  return {
    async open(request) {
      const browser = await abortable(
        playwright.chromium.launch({ headless: true }),
        request.signal,
        "launching the browser",
        (late) => late.close(),
      );

      // Everything after the launch owns the browser: if any of it fails, the browser is closed
      // rather than left running behind a rejected `open`.
      try {
        const context = await browser.newContext();
        await context.addInitScript(INIT_SCRIPT);
        const page = await context.newPage();

        const pending: BrowserEvent[] = [];
        const main = page.mainFrame();
        page.on("console", (message: never) => {
          const typed = message as unknown as { type(): string; text(): string };
          if (typed.type() === "error") {
            pending.push({ type: "console-error", message: typed.text() });
          }
        });
        page.on("pageerror", (error: never) => {
          pending.push({ type: "page-error", message: String(error) });
        });
        page.on("requestfailed", (failed: never) => {
          const typed = failed as unknown as {
            url(): string;
            failure(): { errorText: string } | null;
          };
          pending.push({
            type: "request-failed",
            url: typed.url(),
            message: typed.failure()?.errorText ?? "the request failed",
          });
        });
        page.on("framenavigated", (frame: never) => {
          // Only the main frame: an iframe navigating is not the document being replaced.
          if ((frame as unknown) !== main) return;
          const typed = frame as unknown as { url(): string };
          pending.push({ type: "main-frame-navigated", url: typed.url() });
        });

        await abortable(
          page.goto(request.url, { waitUntil: "load", timeout: request.timeoutMs }),
          request.signal,
          "opening the page",
          nothingToRelease,
        );
        await abortable(
          settle(page),
          request.signal,
          "waiting for the page to settle",
          nothingToRelease,
        );
        // Everything observed while arriving belongs to arriving, not to an update.
        pending.length = 0;

        const adapted: BrowserPage = {
          evaluate: (expression, signal) =>
            abortable(
              page.evaluate(expression),
              signal,
              "evaluating in the page",
              nothingToRelease,
            ),
          drainEvents: () => pending.splice(0, pending.length),
          close: (signal) =>
            abortable(browser.close(), signal, "closing the browser", nothingToRelease),
        };
        return adapted;
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
      }
    },
  };
}

/** Where the pinned checkout's Playwright expects its browser, when it is able to say. */
export function browserExecutable(checkoutRoot: string): string | undefined {
  return loadPlaywright(checkoutRoot).chromium.executablePath?.();
}
