import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { createPlaywrightBrowser } from "../src/browser.ts";

/**
 * A checkout whose `node_modules/playwright` is a stand-in that redirects the page shortly after
 * it opens. The adapter resolves it exactly as it resolves a real checkout's Playwright, so this
 * exercises `open` itself rather than a piece lifted out of it for testing.
 */
function checkoutWithStubPlaywright(): string {
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
  return root;
}

test("a redirect performed while the page is arriving is not reported as an update", async () => {
  const browser = createPlaywrightBrowser(checkoutWithStubPlaywright());
  const controller = new AbortController();

  const page = await browser.open({
    url: "http://localhost:3001/",
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  // Drained after the redirect has certainly been delivered: the stand-in schedules it on the
  // macrotask following `goto`, so it is ordered after arrival begins without depending on any
  // particular delay. Draining before it would pass even with the wait removed, because the
  // event would simply not have happened yet.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const observed = page.drainEvents();
  await page.close(controller.signal);

  // The stand-in navigates the main frame 150ms after `goto` resolves. Reporting it would put an
  // application's own startup routing inside the update window, where the runner reads a
  // main-frame navigation as a full reload.
  assert.deepEqual(
    observed,
    [],
    "the redirect the application performed while arriving was left in the update window",
  );
});

test("a navigation after the page has arrived is reported, with its identity", async () => {
  const checkout = checkoutWithStubPlaywright();
  const browser = createPlaywrightBrowser(checkout);
  const controller = new AbortController();

  const page = await browser.open({
    url: "http://localhost:3001/",
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  page.drainEvents();

  // Arriving is over; this navigation is the document being replaced, and must be reported as
  // such — otherwise discarding the redirect would have cost the adapter its ability to see a
  // real reload at all.
  const stub = createRequire(join(checkout, "package.json"))("playwright") as {
    __lastPage(): { navigate(to: string): void };
  };
  stub.__lastPage().navigate("/reloaded");
  const observed = page.drainEvents();
  await page.close(controller.signal);

  assert.deepEqual(observed, [
    { type: "main-frame-navigated", url: "http://localhost:3001/reloaded" },
  ]);
});
