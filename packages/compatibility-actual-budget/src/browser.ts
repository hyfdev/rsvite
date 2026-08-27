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

interface PlaywrightModule {
  chromium: {
    launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
  };
}

interface PlaywrightBrowser {
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
}

/**
 * Playwright is taken from the pinned checkout rather than added to this repository. The project
 * already pins the version its own tests run under, and measuring it with a different one would
 * make the browser part of the difference being measured.
 */
function loadPlaywright(checkoutRoot: string): PlaywrightModule {
  const require = createRequire(join(checkoutRoot, "package.json"));
  return require("playwright") as PlaywrightModule;
}

/** Settles as soon as the runner gives up, as the adapter contract requires. */
function abortable<T>(work: Promise<T>, signal: AbortSignal, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error(`${what} was aborted`));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function createPlaywrightBrowser(checkoutRoot: string): BrowserAdapter {
  const playwright = loadPlaywright(checkoutRoot);

  return {
    async open(request) {
      const browser = await abortable(
        playwright.chromium.launch({ headless: true }),
        request.signal,
        "launching the browser",
      );
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
      page.on("requestfailed", (request_: never) => {
        const typed = request_ as unknown as {
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
      );
      // The load that brought the page up is not an update, so it is not evidence of a reload.
      pending.length = 0;

      const adapted: BrowserPage = {
        evaluate: (expression, signal) =>
          abortable(page.evaluate(expression), signal, "evaluating in the page"),
        drainEvents: () => pending.splice(0, pending.length),
        close: (signal) => abortable(browser.close(), signal, "closing the browser"),
      };
      return adapted;
    },
  };
}
