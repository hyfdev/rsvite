import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createPlaywrightBrowser, settle, type Observable } from "../src/browser.ts";
import { nextMacrotask, stubCheckout } from "./support.mts";

const FAST = { quietObservations: 3, maxObservations: 12, intervalMs: 0 } as const;

function opening(checkoutRoot: string, signal: AbortSignal) {
  return createPlaywrightBrowser(checkoutRoot).open({
    url: "http://localhost:3001/",
    timeoutMs: 30_000,
    signal,
  });
}

test("a redirect performed while the page is arriving is not reported as an update", async () => {
  const stub = stubCheckout();
  const controller = new AbortController();

  const page = await opening(stub.root, controller.signal);
  // The redirect is ordered after `goto`; letting one macrotask run is enough for it to land,
  // and draining before it would pass even with the arrival wait removed.
  await nextMacrotask();
  const observed = page.drainEvents();
  await page.close(controller.signal);

  assert.deepEqual(
    observed,
    [],
    "the redirect the application performed while arriving was left in the update window",
  );
});

test("a navigation after the page has arrived is reported, with its identity", async () => {
  const stub = stubCheckout();
  const controller = new AbortController();

  const page = await opening(stub.root, controller.signal);
  await nextMacrotask();
  page.drainEvents();
  stub.page().navigate("/reloaded");
  const observed = page.drainEvents();
  await page.close(controller.signal);

  // Discarding the redirect must not have cost the adapter its ability to see a real reload.
  assert.deepEqual(observed, [
    { type: "main-frame-navigated", url: "http://localhost:3001/reloaded" },
  ]);
});

test("a page that never finishes arriving raises instead of opening the update window", async () => {
  const moving: Observable = (() => {
    let observation = 0;
    return {
      url: () => {
        observation += 1;
        return `http://localhost:3001/moving-${String(observation)}`;
      },
    };
  })();

  await assert.rejects(settle(moving, FAST), /never finished arriving/);
});

test("arriving ends after a run of unchanged observations, not after a single one", async () => {
  let observation = 0;
  // Still, then one move, then still again: a single unchanged observation must not end it.
  const flickering: Observable = {
    url: () => {
      observation += 1;
      return observation === 2 ? "http://localhost:3001/bootstrap" : "http://localhost:3001/";
    },
  };

  await settle(flickering, FAST);

  // Three consecutive unchanged observations are required, and the move at the second resets the
  // run, so settling cannot have happened before the sixth.
  assert.ok(observation >= 5, `settled after only ${String(observation)} observations`);
});

test("a browser that finishes launching after the open was aborted is still closed", async () => {
  const stub = stubCheckout({ launchDelayMs: 40 });
  const controller = new AbortController();

  const open = opening(stub.root, controller.signal);
  controller.abort(new Error("the runner gave up"));
  await assert.rejects(open, /launching the browser was aborted/);
  // The launch was already under way; whatever it produced has to be released.
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(stub.launched(), 1, "the stand-in never launched, so nothing was being tested");
  assert.equal(stub.closed(), 1, "the browser produced after the abort was left running");
});

test("a failure after launch closes the browser it had already acquired", async () => {
  const stub = stubCheckout({ failAfterLaunch: true });
  const controller = new AbortController();

  await assert.rejects(opening(stub.root, controller.signal), /context could not be created/);

  assert.equal(stub.launched(), 1);
  assert.equal(stub.closed(), 1, "the browser was left running behind a rejected open");
});

// A setup step that hangs is the shape the runner actually has to survive: `open()` holds a
// browser, the driver stops answering, and the runner gives up. Rejecting is not what is being
// tested — settling at all is.
for (const step of ["newContext", "addInitScript", "newPage"] as const) {
  test(`an abort while ${step} is pending settles the open and closes the browser`, async () => {
    const stub = stubCheckout({ hangIn: step });
    const controller = new AbortController();

    const open = opening(stub.root, controller.signal);
    // The hang has to have started, or aborting would only be racing the launch.
    await nextMacrotask();
    assert.equal(stub.contextStarted(), 1, "the post-launch setup never started");
    controller.abort(new Error("the runner gave up"));

    await assert.rejects(open, /was aborted/, `${step} never settled after the abort`);
    await nextMacrotask();
    assert.equal(stub.closed(), 1, `the browser acquired before ${step} was left running`);
  });
}

test("a page the runner stopped waiting for is no longer being observed", async () => {
  const stub = stubCheckout({ neverSettles: true });
  const controller = new AbortController();

  const open = opening(stub.root, controller.signal);
  // Let the arrival wait take a few observations, so there is something to stop.
  await new Promise((resolve) => setTimeout(resolve, 250));
  controller.abort(new Error("the runner gave up"));
  await assert.rejects(open, /was aborted/);

  // Rejecting the caller is not the same as stopping the work: the runner may not record a
  // result while an operation it abandoned is still driving something.
  const whenAbandoned = stub.page().observations();
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(
    stub.page().observations(),
    whenAbandoned,
    "the page was still being observed after the runner gave up",
  );
  assert.equal(stub.closed(), 1);
});

test("a wait the runner ended does not run on to its next observation", async () => {
  const controller = new AbortController();
  const still: Observable = { url: () => "http://localhost:3001/" };

  // An interval far longer than any test would wait for: the only way this settles is if the
  // wait itself ends when the run is abandoned, rather than sleeping through it.
  const settling = settle(still, { intervalMs: 30_000, maxObservations: 5 }, controller.signal);
  controller.abort(new Error("the runner gave up"));

  await assert.rejects(settling, /abandoned/);
});
