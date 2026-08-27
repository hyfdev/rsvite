import type { BrowserAdapter, BrowserEvent, BrowserPage } from "@rsvite/compatibility-runner";
import { chromium, type Browser, type Page } from "playwright";

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("the browser operation was aborted");
}

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

function isLocalUrl(url: string): boolean {
  return url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost");
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
      if (message.type() !== "error") return;
      this.#events.push({
        type: "console-error",
        message: message.text(),
        ...(message.location().url ? { url: message.location().url } : {}),
      });
    });
    this.#page.on("pageerror", (error) => {
      const message = String(error);
      if (message.includes("NotSupportedError: Model not available")) return;
      this.#events.push({ type: "page-error", message });
    });
    this.#page.on("requestfailed", (request) => {
      const url = request.url();
      if (!isLocalUrl(url)) return;
      this.#events.push({
        type: "request-failed",
        url,
        message: request.failure()?.errorText ?? "the request failed",
      });
    });
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

  discardMainFrameNavigations(): void {
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

export function createChromiumBrowserAdapter(): BrowserAdapter & {
  discardMainFrameNavigations?(page: BrowserPage): void;
} {
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
          page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" }),
          signal,
          async () => {
            await adapted.closeUnchecked();
          },
        );
        adapted.discardMainFrameNavigations();
        return adapted;
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
      }
    },
  };
}

export function discardMainFrameNavigations(page: BrowserPage): void {
  if (typeof (page as ChromiumPage).discardMainFrameNavigations === "function") {
    (page as ChromiumPage).discardMainFrameNavigations();
  }
}

export async function chromiumVersion(): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}
