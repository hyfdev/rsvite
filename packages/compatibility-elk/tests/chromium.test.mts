import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import { test } from "vite-plus/test";
import { ChromiumPage } from "../src/index.ts";

type Handler = (...args: unknown[]) => void;

function stubPage(url = "http://127.0.0.1/home") {
  const listeners = new Map<string, Handler[]>();
  return {
    url: () => url,
    on(event: string, handler: Handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
  };
}

function stubBrowser(): Browser {
  return { close: async () => undefined } as Browser;
}

test("ChromiumPage reports only the page events the adapter is allowed to keep", () => {
  const page = stubPage();
  const adapted = new ChromiumPage(stubBrowser(), page as unknown as Page);

  page.emit("pageerror", new Error("NotSupportedError: Model not available"));
  page.emit("pageerror", new Error("a real page failure"));
  page.emit("requestfailed", {
    url: () => "http://127.0.0.1/app.js",
    failure: () => ({ errorText: "net::ERR_ABORTED" }),
  });
  page.emit("requestfailed", {
    url: () => "https://mastodon.social/api/v1/timelines/home",
    failure: () => ({ errorText: "net::ERR_FAILED" }),
  });
  page.emit("load");
  page.emit("console", {
    type: () => "error",
    text: () => "console boom",
    location: () => ({ url: "http://127.0.0.1/home" }),
  });
  page.emit("console", {
    type: () => "log",
    text: () => "not an error",
    location: () => ({}),
  });

  assert.deepEqual(adapted.drainEvents(), [
    { type: "page-error", message: "Error: a real page failure" },
    {
      type: "request-failed",
      url: "http://127.0.0.1/app.js",
      message: "net::ERR_ABORTED",
    },
    { type: "main-frame-navigated", url: "http://127.0.0.1/home" },
    {
      type: "console-error",
      message: "console boom",
      url: "http://127.0.0.1/home",
    },
  ]);
  assert.deepEqual(adapted.drainEvents(), []);
});
