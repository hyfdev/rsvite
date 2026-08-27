import type { BrowserAdapter, BrowserEvent, BrowserPage } from "@rsvite/compatibility-runner";
import { chromium, type Browser, type Page } from "playwright";

export const DRAWDB_HMR_UPDATE_COUNTER = "__rsviteDrawDbHmrUpdateCount";
export const DRAWDB_HMR_STYLESHEET_PATH = "/src/index.css";

export function isDrawDbStylesheetUpdate(message: unknown, stylesheetPath: string): boolean {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const payload = message as Record<string, unknown>;
  if (payload["type"] !== "update" || !Array.isArray(payload["updates"])) return false;
  return payload["updates"].some((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return false;
    }
    const update = candidate as Record<string, unknown>;
    return update["path"] === stylesheetPath || update["acceptedPath"] === stylesheetPath;
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("the browser operation was aborted");
}

function isKnownDrawDbReactWarning(message: string): boolean {
  return (
    message.startsWith("Warning: Invalid DOM property") ||
    message.startsWith("Warning: findDOMNode is deprecated")
  );
}

/**
 * Resolve or reject as soon as the runner cancels, while still disposing a late browser resource.
 * The runner gives adapter cleanup a short grace period, so leaving a late launch alive would make
 * a cancelled compatibility run retain a real Chromium process.
 */
function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  dispose: (value: T) => Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    void operation.then(dispose, () => undefined);
    return Promise.reject(abortError(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      finish();
      void operation.then(dispose, () => undefined);
      reject(abortError(signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        if (settled) {
          void dispose(value);
          return;
        }
        settled = true;
        finish();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      },
    );
  });
}

class ChromiumPage implements BrowserPage {
  readonly #browser: Browser;
  readonly #events: BrowserEvent[] = [];
  readonly #page: Page;
  #closed = false;

  constructor(browser: Browser, page: Page) {
    this.#browser = browser;
    this.#page = page;
    this.#page.on("console", (message) => {
      // DrawDB's known React development warnings are emitted through console.error even though
      // no script, page, or request failed. Other console errors remain compatibility evidence.
      if (message.type() === "error" && !isKnownDrawDbReactWarning(message.text())) {
        this.#events.push({
          type: "console-error",
          message: message.text(),
          ...(message.location().url ? { url: message.location().url } : {}),
        });
      }
    });
    this.#page.on("pageerror", (error) => {
      this.#events.push({ type: "page-error", message: String(error) });
    });
    this.#page.on("requestfailed", (request) => {
      this.#events.push({
        type: "request-failed",
        url: request.url(),
        message: request.failure()?.errorText ?? "the request failed",
      });
    });
    // Playwright also emits framenavigated for history.pushState. DrawDB saves a new diagram by
    // changing its client-side route, which preserves the current document and sentinel. A load
    // is the browser event that identifies a replaced main document, the condition HMR must fail.
    this.#page.on("load", () => {
      this.#events.push({ type: "main-frame-navigated", url: this.#page.url() });
    });
  }

  evaluate(expression: string, signal: AbortSignal): Promise<unknown> {
    return abortable(this.#page.evaluate(expression), signal, () => this.closeUnchecked());
  }

  drainEvents(): BrowserEvent[] {
    return this.#events.splice(0);
  }

  /** The first document load establishes the browser session; only later loads are HMR evidence. */
  discardInitialNavigation(): void {
    const retained = this.#events.filter((event) => event.type !== "main-frame-navigated");
    this.#events.splice(0, this.#events.length, ...retained);
  }

  close(signal: AbortSignal): Promise<void> {
    return abortable(this.closeUnchecked(), signal, () => this.closeUnchecked());
  }

  async closeUnchecked(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#browser.close();
  }
}

/** A real Chromium adapter for a compatibility run; verdicts stay in the shared runner. */
export function createChromiumBrowserAdapter(): BrowserAdapter {
  return {
    async open({ url, timeoutMs, signal }): Promise<BrowserPage> {
      const browser = await abortable(
        chromium.launch({ headless: true }),
        signal,
        async (value) => {
          await value.close();
        },
      );

      try {
        const page = await abortable(browser.newPage(), signal, async () => {
          await browser.close();
        });
        const adapted = new ChromiumPage(browser, page);
        await abortable(
          page.addInitScript({
            content: `(() => {
              const counter = ${JSON.stringify(DRAWDB_HMR_UPDATE_COUNTER)};
              const isStylesheetUpdate = ${isDrawDbStylesheetUpdate.toString()};
              const stylesheetPath = ${JSON.stringify(DRAWDB_HMR_STYLESHEET_PATH)};
              globalThis[counter] = 0;
              const NativeWebSocket = globalThis.WebSocket;
              if (NativeWebSocket === undefined) return;
              globalThis.WebSocket = class extends NativeWebSocket {
                constructor(...args) {
                  super(...args);
                  this.addEventListener("message", (event) => {
                    if (typeof event.data !== "string") return;
                    try {
                      if (isStylesheetUpdate(JSON.parse(event.data), stylesheetPath)) {
                        globalThis[counter] += 1;
                      }
                    } catch {}
                  });
                }
              };
            })()`,
          }),
          signal,
          async () => {
            await adapted.closeUnchecked();
          },
        );
        // DrawDB's root-relative Vercel telemetry endpoint exists only on its deployed host.
        // Serve an empty script locally so preview acceptance measures DrawDB, not that host.
        await abortable(
          page.route("**/_vercel/insights/script.js", (route) =>
            route.fulfill({ contentType: "application/javascript", body: "" }),
          ),
          signal,
          async () => {
            await adapted.closeUnchecked();
          },
        );
        await abortable(
          page.goto(url, { timeout: timeoutMs, waitUntil: "load" }),
          signal,
          async () => {
            await adapted.closeUnchecked();
          },
        );
        adapted.discardInitialNavigation();
        return adapted;
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
      }
    },
  };
}

/** The actual browser revision belongs in the result environment, not in a guessed constant. */
export async function chromiumVersion(): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}
