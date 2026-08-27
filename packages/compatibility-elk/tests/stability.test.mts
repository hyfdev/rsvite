import assert from "node:assert/strict";
import type { BrowserAdapter, BrowserEvent, BrowserPage } from "@rsvite/compatibility-runner";
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

test("the ELK adapter excludes cold events and still reports errors after stability", async () => {
  const cold: BrowserEvent[] = [
    {
      type: "console-error",
      message:
        "Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep)",
    },
  ];
  const after: BrowserEvent[] = [{ type: "page-error", message: "acceptance boom" }];
  let opens = 0;
  const warmup = fakePage({ drains: [cold, [], []] });
  const acceptance = fakePage({ drains: [[], []], extraAfter: after });
  const inner: BrowserAdapter = {
    async open() {
      opens += 1;
      return opens === 1 ? warmup : acceptance;
    },
  };

  const adapter = createElkBrowserAdapter({
    inner,
    pollMs: 0,
    quietObservations: 2,
    timeoutMs: 1_000,
    sleep: abortableSleep,
  });
  const page = await adapter.open({
    url: "http://127.0.0.1/home",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });

  const coldPhase = adapter.takeColdPhase();
  assert.equal(opens, 2);
  assert.ok(coldPhase);
  assert.equal(coldPhase.cacheState, "warm");
  assert.deepEqual(coldPhase.events, cold);
  assert.deepEqual(page.drainEvents(), after);
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
