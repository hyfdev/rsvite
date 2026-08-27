import assert from "node:assert/strict";
import type { BrowserEvent, BrowserPage } from "@rsvite/compatibility-runner";
import { test } from "vite-plus/test";
import { createElkBrowserAdapter, waitForObservedStability } from "../src/index.ts";

function abortableSleep(_milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  }
  return Promise.resolve();
}

function fakePage(script: {
  readonly drains: readonly (readonly BrowserEvent[])[];
  readonly extraAfter?: readonly BrowserEvent[];
}): BrowserPage & { remaining(): number } {
  const queues = script.drains.map((batch) => [...batch]);
  let extraEmitted = false;
  return {
    remaining: () => queues.length,
    evaluate: async () => true,
    drainEvents(): BrowserEvent[] {
      if (queues.length > 0) return queues.shift() ?? [];
      if (!extraEmitted && script.extraAfter !== undefined) {
        extraEmitted = true;
        return [...script.extraAfter];
      }
      return [];
    },
    close: async () => undefined,
  };
}

test("cold-phase errors and navigations are returned and then gone from the page", async () => {
  const cold: BrowserEvent[] = [
    {
      type: "console-error",
      message:
        "Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep)",
    },
    { type: "main-frame-navigated", url: "http://127.0.0.1/home" },
    {
      type: "request-failed",
      url: "http://127.0.0.1/node_modules/.cache/vite/client/deps/tiny-decode.js",
      message: "net::ERR_ABORTED",
    },
  ];
  const page = fakePage({
    drains: [cold, [], []],
    extraAfter: [{ type: "page-error", message: "acceptance boom" }],
  });
  const signal = new AbortController().signal;
  const collected = await waitForObservedStability(page, signal, {
    pollMs: 0,
    quietObservations: 2,
    timeoutMs: 1_000,
    sleep: abortableSleep,
  });

  assert.deepEqual(collected, cold);
  assert.deepEqual(page.drainEvents(), [{ type: "page-error", message: "acceptance boom" }]);
});

test("a page that keeps reloading never counts as stable", async () => {
  const page: BrowserPage = {
    evaluate: async () => true,
    drainEvents: () => [{ type: "main-frame-navigated", url: "http://127.0.0.1/home" }],
    close: async () => undefined,
  };
  await assert.rejects(
    () =>
      waitForObservedStability(page, new AbortController().signal, {
        pollMs: 0,
        quietObservations: 2,
        timeoutMs: 20,
        sleep: abortableSleep,
      }),
    /did not reach a stable state/,
  );
});

function elkAdapter(warmup: BrowserPage, acceptance: BrowserPage) {
  let opens = 0;
  return createElkBrowserAdapter({
    inner: {
      async open() {
        opens += 1;
        return opens === 1 ? warmup : acceptance;
      },
    },
    pollMs: 0,
    quietObservations: 2,
    timeoutMs: 1_000,
    sleep: abortableSleep,
  });
}

test("an error the acceptance page emits on arrival is for the runner, not the cold record", async () => {
  const cold: BrowserEvent[] = [
    {
      type: "console-error",
      message:
        "Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep)",
    },
  ];
  const arrival: BrowserEvent[] = [{ type: "page-error", message: "acceptance boom" }];
  const warmup = fakePage({ drains: [cold, [], []] });
  const acceptance = fakePage({ drains: [arrival] });
  const adapter = elkAdapter(warmup, acceptance);
  const page = await adapter.open({
    url: "http://127.0.0.1/home",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });

  const coldPhase = adapter.takeColdPhase();
  assert.ok(coldPhase);
  assert.deepEqual(coldPhase.events, cold);
  assert.deepEqual(page.drainEvents(), arrival);
});

test("a main-frame navigation after the warm-up quiet streak stays on the acceptance page", async () => {
  const cold: BrowserEvent[] = [
    { type: "main-frame-navigated", url: "http://127.0.0.1/home?cold=1" },
  ];
  const later: BrowserEvent[] = [
    { type: "main-frame-navigated", url: "http://127.0.0.1/home?reloaded=1" },
  ];
  const warmup = fakePage({ drains: [cold, [], []] });
  const acceptance = fakePage({ drains: [later] });
  const adapter = elkAdapter(warmup, acceptance);
  const page = await adapter.open({
    url: "http://127.0.0.1/home",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });

  const coldPhase = adapter.takeColdPhase();
  assert.ok(coldPhase);
  assert.deepEqual(coldPhase.events, cold);
  assert.deepEqual(page.drainEvents(), later);
});

test("deleting the quiet streak leaves cold errors on the page", async () => {
  const cold: BrowserEvent[] = [
    {
      type: "console-error",
      message:
        "Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep)",
    },
  ];
  const page = fakePage({ drains: [cold] });
  const remaining = page.drainEvents();
  assert.deepEqual(remaining, cold);
  assert.deepEqual(page.drainEvents(), []);
});
