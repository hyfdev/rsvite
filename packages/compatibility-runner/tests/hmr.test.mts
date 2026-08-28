import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vite-plus/test";
import {
  runCompatibilityCheck,
  type BrowserAdapter,
  type BrowserEvent,
  type BrowserPage,
} from "../src/index.ts";
import { baseRequest, freePort, withPort } from "./support.mts";

const SENTINEL = "globalThis.__rsviteHmrSentinel";

class FileBackedPage implements BrowserPage {
  sawExpectedText = false;

  constructor(
    private readonly source: string,
    private readonly expectedText: string,
    private readonly observesSource = true,
  ) {}

  async evaluate(expression: string, signal: AbortSignal): Promise<unknown> {
    assert.equal(signal.aborted, false);
    if (expression === SENTINEL) return "session-1";
    if (expression.includes("document.body?.innerText.includes")) {
      const found =
        this.observesSource && (await readFile(this.source, "utf8")).includes(this.expectedText);
      if (found) this.sawExpectedText = true;
      return found;
    }
    throw new Error(`unexpected browser expression: ${expression}`);
  }

  drainEvents(): BrowserEvent[] {
    return [];
  }

  async close(): Promise<void> {}
}

function fileBrowser(
  source: string,
  expectedText: string,
  observesSource = true,
): BrowserAdapter & {
  page(): FileBackedPage | undefined;
} {
  let page: FileBackedPage | undefined;
  return {
    page: () => page,
    async open(): Promise<BrowserPage> {
      page = new FileBackedPage(source, expectedText, observesSource);
      return page;
    },
  };
}

function claimingHmr(manifest: unknown, editPath = "index.html"): unknown {
  const document = structuredClone(manifest) as {
    entries: {
      browserAcceptance: { hmr: { edit: { path: string } } };
      expectedCapabilities: string[];
    }[];
  };
  const entry = document.entries[0]!;
  entry.expectedCapabilities = ["html", "hmr-without-full-reload"];
  entry.browserAcceptance.hmr.edit.path = editPath;
  return document;
}

async function setup(
  initial = "served",
  observesSource = true,
): Promise<{
  browser: ReturnType<typeof fileBrowser>;
  manifest: unknown;
  request: Awaited<ReturnType<typeof baseRequest>>;
  source: string;
  cleanup(): Promise<void>;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "rsvite-runner-hmr-"));
  const source = join(projectRoot, "index.html");
  await writeFile(source, initial);
  const port = await freePort();
  const browser = fileBrowser(source, "served again", observesSource);
  const request = await baseRequest("rsvite", {
    projectRoot,
    origin: `http://127.0.0.1:${String(port)}`,
    browser,
  });
  const manifest = withPort(claimingHmr(request.manifest), port);
  return {
    browser,
    manifest,
    request: {
      ...request,
      declared: {
        ...request.declared,
        capabilityOwners: [{ capability: "hmr-without-full-reload", owner: "rust" }],
      },
    },
    source,
    async cleanup(): Promise<void> {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(request.artifactRoot, { recursive: true, force: true });
    },
  };
}

test("the runner applies and restores the manifest-declared HMR edit by default", async () => {
  const run = await setup();
  try {
    const report = await runCompatibilityCheck({ ...run.request, manifest: run.manifest });

    assert.equal((report.result as { outcome: string }).outcome, "pass");
    assert.equal(run.browser.page()?.sawExpectedText, true);
    assert.equal(await readFile(run.source, "utf8"), "served");
  } finally {
    await run.cleanup();
  }
});

test("an adapter override applies the bound manifest declaration", async () => {
  const run = await setup();
  try {
    const report = await runCompatibilityCheck({
      ...run.request,
      manifest: run.manifest,
      update: async (_page, _signal, hmr) => {
        assert.equal(hmr.expectedText, "served again");
        await hmr.apply();
        assert.equal(await readFile(run.source, "utf8"), "served again");
      },
    });

    assert.equal((report.result as { outcome: string }).outcome, "pass");
    assert.equal(await readFile(run.source, "utf8"), "served");
  } finally {
    await run.cleanup();
  }
});

test("an adapter may observe and restore the declared edit inside its update window", async () => {
  const run = await setup();
  try {
    const report = await runCompatibilityCheck({
      ...run.request,
      manifest: run.manifest,
      update: async (_page, _signal, hmr) => {
        await hmr.apply();
        await hmr.restore();
        assert.equal(await readFile(run.source, "utf8"), "served");
      },
    });

    assert.equal((report.result as { outcome: string }).outcome, "pass");
    assert.equal(run.browser.page()?.sawExpectedText, true);
  } finally {
    await run.cleanup();
  }
});

test("an early restoration cannot make expected text from the original source count", async () => {
  const run = await setup();
  const manifest = structuredClone(run.manifest) as {
    entries: {
      browserAcceptance: {
        hmr: {
          edit: { find: string; replace: string };
          expectedText: string;
        };
      };
    }[];
  };
  const hmr = manifest.entries[0]!.browserAcceptance.hmr;
  hmr.edit.replace = "changed";
  hmr.expectedText = "served";
  const browser = fileBrowser(run.source, "served");
  try {
    const report = await runCompatibilityCheck({
      ...run.request,
      browser,
      manifest,
      update: async (_page, _signal, update) => {
        await update.apply();
        await update.restore();
      },
    });
    const result = report.result as {
      outcome: string;
      firstIncompatibleBehavior: { message: string };
    };

    assert.equal(result.outcome, "fail");
    assert.match(result.firstIncompatibleBehavior.message, /did not produce.*expectedText/);
    assert.equal(browser.page()?.sawExpectedText, false);
    assert.equal(await readFile(run.source, "utf8"), "served");
  } finally {
    await run.cleanup();
  }
});

test("an adapter override cannot return without applying the declared edit", async () => {
  const run = await setup();
  try {
    const report = await runCompatibilityCheck({
      ...run.request,
      manifest: run.manifest,
      update: async () => undefined,
    });
    const result = report.result as {
      outcome: string;
      firstIncompatibleBehavior: { message: string };
    };

    assert.equal(result.outcome, "fail");
    assert.match(result.firstIncompatibleBehavior.message, /did not apply the manifest-declared/);
    assert.equal(await readFile(run.source, "utf8"), "served");
  } finally {
    await run.cleanup();
  }
});

test("the runner restores the declared edit when an adapter fails after applying it", async () => {
  const run = await setup();
  try {
    const report = await runCompatibilityCheck({
      ...run.request,
      manifest: run.manifest,
      update: async (_page, _signal, hmr) => {
        await hmr.apply();
        throw new Error("project-specific observation failed");
      },
    });

    assert.equal((report.result as { outcome: string }).outcome, "fail");
    assert.equal(await readFile(run.source, "utf8"), "served");
  } finally {
    await run.cleanup();
  }
});

test("an adapter override must make the declared expected text observable", async () => {
  const run = await setup("served", false);
  try {
    const report = await runCompatibilityCheck({
      ...run.request,
      manifest: run.manifest,
      update: async (_page, _signal, hmr) => hmr.apply(),
    });
    const result = report.result as {
      outcome: string;
      firstIncompatibleBehavior: { message: string };
    };

    assert.equal(result.outcome, "fail");
    assert.match(result.firstIncompatibleBehavior.message, /did not produce.*expectedText/);
    assert.equal(await readFile(run.source, "utf8"), "served");
  } finally {
    await run.cleanup();
  }
});

test("the runner restores the declared edit after the update times out", async () => {
  const run = await setup();
  try {
    const report = await runCompatibilityCheck({
      ...run.request,
      manifest: run.manifest,
      update: async (_page, signal, hmr) => {
        await hmr.apply();
        await delay(60_000, undefined, { signal });
      },
      timeouts: { ...run.request.timeouts, browserMs: 100 },
    });

    assert.equal((report.result as { outcome: string }).outcome, "fail");
    assert.equal(await readFile(run.source, "utf8"), "served");
  } finally {
    await run.cleanup();
  }
});

test("a callback cannot apply its edit after the update window is abandoned", async () => {
  const run = await setup();
  let lateApply: Promise<void> | undefined;
  try {
    const check = runCompatibilityCheck({
      ...run.request,
      manifest: run.manifest,
      update: (_page, _signal, hmr) => {
        lateApply = (async () => {
          await delay(1_500);
          await hmr.apply();
        })();
        return lateApply;
      },
      timeouts: { ...run.request.timeouts, browserMs: 100 },
    });

    await assert.rejects(check, /abort-settle contract/);
    assert.ok(lateApply);
    await assert.rejects(lateApply, /cannot be applied after the update window closes/);
    assert.equal(await readFile(run.source, "utf8"), "served");
  } finally {
    await run.cleanup();
  }
});

test("the runner rejects traversal and symlink escapes before changing an outside file", async () => {
  for (const escape of ["../outside.html", "linked.html"] as const) {
    const container = await mkdtemp(join(tmpdir(), "rsvite-runner-hmr-boundary-"));
    const projectRoot = join(container, "project");
    const outside = join(container, "outside.html");
    await mkdir(projectRoot);
    await writeFile(outside, "served");
    if (escape === "linked.html") await symlink(outside, join(projectRoot, escape));
    const port = await freePort();
    const browser = fileBrowser(outside, "served again");
    const request = await baseRequest("rsvite", {
      projectRoot,
      origin: `http://127.0.0.1:${String(port)}`,
      browser,
    });
    const manifest = withPort(claimingHmr(request.manifest, escape), port);
    let outsideAfterApply: string | undefined;
    try {
      const report = await runCompatibilityCheck({
        ...request,
        manifest,
        declared: {
          ...request.declared,
          capabilityOwners: [{ capability: "hmr-without-full-reload", owner: "rust" }],
        },
        update: async (_page, _signal, hmr) => {
          try {
            await hmr.apply();
          } finally {
            outsideAfterApply = await readFile(outside, "utf8");
          }
        },
      });
      const result = report.result as {
        outcome: string;
        firstIncompatibleBehavior: { message: string };
      };

      assert.equal(result.outcome, "fail", escape);
      assert.match(result.firstIncompatibleBehavior.message, /escapes the project root/, escape);
      assert.equal(outsideAfterApply, "served", escape);
      assert.equal(browser.page()?.sawExpectedText, false, escape);
      assert.equal(await readFile(outside, "utf8"), "served", escape);
    } finally {
      await rm(container, { recursive: true, force: true });
      await rm(request.artifactRoot, { recursive: true, force: true });
    }
  }
});

test("the default update requires expectedText to become observable after the edit", async () => {
  const run = await setup("served again and served");
  try {
    const report = await runCompatibilityCheck({ ...run.request, manifest: run.manifest });
    const result = report.result as {
      outcome: string;
      firstIncompatibleBehavior: { message: string };
    };

    assert.equal(result.outcome, "fail");
    assert.match(result.firstIncompatibleBehavior.message, /already present before the edit/);
    assert.equal(await readFile(run.source, "utf8"), "served again and served");
  } finally {
    await run.cleanup();
  }
});
