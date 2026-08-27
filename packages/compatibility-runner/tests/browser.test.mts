import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  createSyntheticBrowser,
  judgeUpdateWindow,
  normalizeEvents,
  runCompatibilityCheck,
} from "../src/index.ts";
import { baseRequest, freePort, withPort } from "./support.mts";

test("an update that keeps the in-memory sentinel and does not navigate is not a reload", () => {
  const verdict = judgeUpdateWindow({
    sentinelBefore: "session-1",
    sentinelAfter: "session-1",
    events: [{ type: "console-error", message: "unrelated" }],
  });

  assert.deepEqual(verdict, { fullReload: false });
});

test("any main-frame navigation in the update window is a reload", () => {
  const verdict = judgeUpdateWindow({
    sentinelBefore: "session-1",
    sentinelAfter: "session-1",
    events: [{ type: "main-frame-navigated", url: "http://127.0.0.1:5173/" }],
  });

  assert.equal(verdict.fullReload, true);
  assert.match(verdict.reason ?? "", /main frame navigated/);
});

test("a sentinel that did not survive is a reload even without a navigation record", () => {
  const verdict = judgeUpdateWindow({
    sentinelBefore: "session-1",
    sentinelAfter: undefined,
    events: [],
  });

  assert.equal(verdict.fullReload, true);
  assert.match(verdict.reason ?? "", /did not survive/);
});

test("events are normalized into the shape a raw result records", () => {
  const observation = normalizeEvents([
    { type: "console-error", message: "boom", url: "http://127.0.0.1/app.js" },
    { type: "page-error", message: "threw" },
    { type: "request-failed", url: "http://127.0.0.1/missing.css", message: "404" },
    { type: "main-frame-navigated", url: "http://127.0.0.1/" },
    { type: "main-frame-navigated", url: "http://127.0.0.1/" },
  ]);

  assert.equal(observation.mainFrameNavigations, 2);
  assert.deepEqual(
    observation.errors.map((error) => error.type),
    ["console-error", "page-error", "request-failure"],
  );
});

test("a simulated full reload loses the sentinel and fails the run", async () => {
  const port = await freePort();
  const browser = createSyntheticBrowser({
    documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
  });
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser,
    // A real adapter would edit a file and wait; this one replaces the document, which is what
    // a full reload does. The new document does not inherit the old document's memory.
    update: () => {
      browser.lastPage()?.navigate(`http://127.0.0.1:${String(port)}/`);
      return Promise.resolve();
    },
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });
  const result = report.result as Record<string, unknown>;
  const failure = result["firstIncompatibleBehavior"] as { phase: string; message: string };

  assert.equal(result["outcome"], "fail");
  assert.equal(failure.phase, "browser");
  assert.match(failure.message, /full reload/);
});

test("an update that preserves the sentinel passes the same path", async () => {
  const port = await freePort();
  const browser = createSyntheticBrowser({
    documentMemory: { "globalThis.__rsviteHmrSentinel": "session-1" },
  });
  const request = await baseRequest("rsvite", {
    origin: `http://127.0.0.1:${String(port)}`,
    browser,
    update: () => Promise.resolve(),
  });

  const report = await runCompatibilityCheck({
    ...request,
    manifest: withPort(request.manifest, port),
  });

  assert.equal((report.result as Record<string, unknown>)["outcome"], "pass");
});
