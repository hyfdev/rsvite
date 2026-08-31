import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, test } from "vite-plus/test";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../..");
const pnpmBin = resolve(repositoryRoot, "node_modules/.bin/rsvite");
const htmlFixtureRoot = resolve(repositoryRoot, "fixtures/m1-basic-html");
const typescriptFixtureRoot = resolve(repositoryRoot, "fixtures/m1-basic-typescript");
const cssAssetFixtureRoot = resolve(repositoryRoot, "fixtures/m1-basic-css-assets");

/**
 * Waits until the page is listening for saves again.
 *
 * A page between documents has no event stream, so a save made while it is loading reaches no
 * stream of its own; the load already under way serves the newest files instead. A test that
 * edits again after a reload therefore waits for the new document to open its own stream first,
 * or it would be waiting for a reload that was never sent to anyone.
 */
function listeningAgain(page) {
  return page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === "/@rsvite/events",
    { timeout: 15_000 },
  );
}

function waitForAddress(child) {
  return new Promise((resolveAddress, rejectAddress) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => rejectAddress(new Error(`server did not start:\n${stderr}`)),
      10_000,
    );
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/Local: http:\/\/(127\.0\.0\.1:(\d+))\//);
      if (match === null) return;
      clearTimeout(timer);
      resolveAddress({ origin: `http://${match[1]}`, port: Number(match[2]) });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      rejectAddress(
        new Error(
          `server exited before readiness: code=${String(code)} signal=${String(signal)}\n${stderr}`,
        ),
      );
    });
  });
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function provePortCanRebind(port) {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

async function interruptOnFirstReadiness(root, signal) {
  const child = spawn(pnpmBin, [root, "--port", "0"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = waitForExit(child);
  let stderr = "";
  let stdout = "";
  let readinessSeen = false;
  const readiness = new Promise((resolvePort, rejectPort) => {
    const timer = setTimeout(
      () => rejectPort(new Error(`server did not publish readiness:\n${stderr}`)),
      10_000,
    );
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/Local: http:\/\/127\.0\.0\.1:(\d+)\//);
      if (readinessSeen || match === null) return;
      readinessSeen = true;
      clearTimeout(timer);
      const delivered = child.kill(signal);
      if (!delivered) {
        rejectPort(new Error(`${signal} could not be delivered at readiness`));
        return;
      }
      resolvePort(Number(match[1]));
    });
    child.once("exit", (code, exitSignal) => {
      if (readinessSeen) return;
      clearTimeout(timer);
      rejectPort(
        new Error(
          `server exited before readiness: code=${String(code)} signal=${String(exitSignal)}\n${stderr}`,
        ),
      );
    });
    child.once("error", rejectPort);
  });

  try {
    const port = await readiness;
    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    await provePortCanRebind(port);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit.catch(() => undefined);
  }
}

async function proveBrowserModuleFixture({
  fixtureRoot,
  entryPath,
  dependencyPath,
  title,
  initialText,
  updatedText,
  transformedIncludes,
  transformedExcludes,
  dependencyExcludes = [],
  rejectedEntrySource,
}) {
  const root = await mkdtemp(join(tmpdir(), "rsvite-m1-module-"));
  await cp(fixtureRoot, root, { recursive: true });
  const child = spawn(pnpmBin, [root, "--port", "0"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = waitForExit(child);
  let browser;

  try {
    const { origin, port } = await waitForAddress(child);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    const entryResponse = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === entryPath,
    );
    const dependencyResponse = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === dependencyPath,
    );
    const response = await page.goto(`${origin}/`);
    const entry = await entryResponse;
    const dependency = await dependencyResponse;
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-type"]).toBe("text/html; charset=utf-8");
    expect(entry.status()).toBe(200);
    expect(entry.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(entry.headers()["cache-control"]).toBe("no-store");
    const transformedEntry = await entry.text();
    for (const expected of transformedIncludes) expect(transformedEntry).toContain(expected);
    for (const unsupported of transformedExcludes) {
      expect(transformedEntry).not.toContain(unsupported);
    }
    expect(dependency.status()).toBe(200);
    const transformedDependency = await dependency.text();
    for (const unsupported of dependencyExcludes) {
      expect(transformedDependency).not.toContain(unsupported);
    }
    await expect(page.title()).resolves.toBe(title);
    await expect(page.textContent("#app")).resolves.toBe(initialText);
    expect(errors).toEqual([]);

    // Saving the dependency reloads the open page by itself, so nothing here asks it to.
    const listening = listeningAgain(page);
    const dependencyFile = join(root, dependencyPath);
    const first = await readFile(dependencyFile, "utf8");
    expect(first).toContain(initialText);
    const reloadedDependency = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === dependencyPath,
      { timeout: 15_000 },
    );
    await writeFile(dependencyFile, first.replace(initialText, updatedText));
    expect((await reloadedDependency).status()).toBe(200);
    await page.waitForFunction(
      (expected) => document.querySelector("#app")?.textContent === expected,
      updatedText,
      { timeout: 15_000 },
    );
    expect(errors).toEqual([]);
    await listening;

    if (rejectedEntrySource !== undefined) {
      const rejectedEntryResponse = page.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname === entryPath && candidate.status() === 400,
        { timeout: 15_000 },
      );
      await writeFile(join(root, entryPath), rejectedEntrySource);
      expect((await rejectedEntryResponse).status()).toBe(400);
      await page.waitForFunction(
        () => document.querySelector("#app")?.textContent === "loading",
        null,
        { timeout: 15_000 },
      );
    }

    child.kill("SIGTERM");
    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    await provePortCanRebind(port);
  } finally {
    try {
      await browser?.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`the first readiness bytes already guarantee clean ${signal} shutdown`, async () => {
    const root = await mkdtemp(join(tmpdir(), "rsvite-m1-readiness-"));
    await cp(resolve(htmlFixtureRoot, "index.html"), join(root, "index.html"));
    try {
      for (let trial = 0; trial < 10; trial += 1) {
        await interruptOnFirstReadiness(root, signal);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
}

test("pnpm's rsvite bin executes Rust-resolved modules, reloads a dependency, and shuts down", async () => {
  await proveBrowserModuleFixture({
    fixtureRoot: htmlFixtureRoot,
    entryPath: "/src/main.js",
    dependencyPath: "/src/message.js",
    title: "rsvite M1 HTML",
    initialText: "served by Rust",
    updatedText: "served by Rust again",
    transformedIncludes: ['from "/src/message.js"'],
    transformedExcludes: ['from "./message"'],
  });
});

test("pnpm's rsvite bin executes basic TypeScript and rejects retained class modifiers", async () => {
  await proveBrowserModuleFixture({
    fixtureRoot: typescriptFixtureRoot,
    entryPath: "/src/main.ts",
    dependencyPath: "/src/message.ts",
    title: "rsvite M1 TypeScript",
    initialText: "served by Rust TypeScript",
    updatedText: "served by Rust TypeScript again",
    transformedIncludes: ['from "/src/message.ts"'],
    transformedExcludes: ['from "./message"', ": Element | null"],
    dependencyExcludes: [": string"],
    rejectedEntrySource: `import { message } from "./message";
class Value { public text = message }
const target: Element | null = document.querySelector("#app");
if (target !== null) target.textContent = new Value().text;
`,
  });
});

test("pnpm's rsvite bin serves the stylesheet and the asset it names, and rereads both", async () => {
  const root = await mkdtemp(join(tmpdir(), "rsvite-m1-resources-"));
  await cp(cssAssetFixtureRoot, root, { recursive: true });
  const child = spawn(pnpmBin, [root, "--port", "0"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = waitForExit(child);
  let browser;

  try {
    const { origin, port } = await waitForAddress(child);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("requestfailed", (request) => {
      errors.push(`${request.url()} ${request.failure()?.errorText ?? "failed"}`);
    });

    const stylesheetResponse = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/src/styles.css",
    );
    // The browser produces this request by resolving the stylesheet's own relative URL; the
    // server never parsed the CSS.
    const assetResponse = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/assets/mark.svg",
    );
    await page.goto(`${origin}/`);
    const stylesheet = await stylesheetResponse;
    const asset = await assetResponse;

    expect(stylesheet.status()).toBe(200);
    expect(stylesheet.headers()["content-type"]).toBe("text/css; charset=utf-8");
    expect(stylesheet.headers()["cache-control"]).toBe("no-store");
    expect(asset.status()).toBe(200);
    expect(asset.headers()["content-type"]).toBe("image/svg+xml");
    expect(asset.headers()["cache-control"]).toBe("no-store");
    expect(await asset.text()).toContain("<circle");

    const colour = () =>
      page.evaluate(() => getComputedStyle(document.querySelector("#app")).color);
    await expect(colour()).resolves.toBe("rgb(16, 94, 160)");
    expect(errors).toEqual([]);

    // Each edit reloads the page by itself: no restart, and the new bytes are what it gets.
    const listening = listeningAgain(page);
    const stylesheetFile = join(root, "src/styles.css");
    await writeFile(
      stylesheetFile,
      (await readFile(stylesheetFile, "utf8")).replace("rgb(16, 94, 160)", "rgb(3, 122, 51)"),
    );
    await page.waitForFunction(
      (expected) => getComputedStyle(document.querySelector("#app")).color === expected,
      "rgb(3, 122, 51)",
      { timeout: 15_000 },
    );
    await listening;

    const reloadedAsset = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/assets/mark.svg",
      { timeout: 15_000 },
    );
    const assetFile = join(root, "assets/mark.svg");
    await writeFile(assetFile, (await readFile(assetFile, "utf8")).replace("circle", "ellipse"));
    expect(await (await reloadedAsset).text()).toContain("<ellipse");
    expect(errors).toEqual([]);

    child.kill("SIGTERM");
    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    await provePortCanRebind(port);
  } finally {
    try {
      await browser?.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
});

/**
 * Replaces a file the way an editor that writes to a temporary file does.
 *
 * The replacement arrives at the target through a rename, so the watcher sees the target appear
 * rather than change; the temporary name is not one this server serves.
 */
async function replaceAtomically(target, contents) {
  const pending = `${target}.pending`;
  await writeFile(pending, contents);
  await rename(pending, target);
}

/**
 * Proves each save reaches the open page without the test asking the page to do anything.
 *
 * Two signals decide it. The main frame navigates inside the edit window, and a value that exists
 * only on the previous document's global object is gone afterwards — a document that was never
 * replaced keeps it. The stream being open is the barrier before the first edit, so the page is
 * listening when the save happens, and nothing here calls `page.reload()`.
 *
 * Each round is its own edit window, so one kind of file cannot stand in for another: a round
 * whose file the watcher does not accept fails on its own rather than riding on the next one.
 */
async function proveAutomaticReload({ fixtureRoot, prepare, rounds }) {
  const root = await mkdtemp(join(tmpdir(), "rsvite-m1-reload-"));
  await cp(fixtureRoot, root, { recursive: true });
  // Whatever a case needs in place happens before the server starts, so preparing the project is
  // never itself an edit this server could reload for.
  await prepare?.({ root });
  const child = spawn(pnpmBin, [root, "--port", "0"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = waitForExit(child);
  let browser;

  try {
    const { origin, port } = await waitForAddress(child);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("requestfailed", (request) => {
      errors.push(`${request.url()} ${request.failure()?.errorText ?? "failed"}`);
    });
    const navigations = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });

    const eventStream = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/@rsvite/events",
    );
    await page.goto(`${origin}/`);
    const stream = await eventStream;
    expect(stream.status()).toBe(200);
    expect(stream.headers()["content-type"]).toBe("text/event-stream");
    expect(stream.headers()["cache-control"]).toBe("no-store");
    expect(errors).toEqual([]);

    for (const [index, { edit, verify }] of rounds.entries()) {
      // Only this document can have this value; the next document starts without it.
      const sentinel = `before save ${String(index)}`;
      await page.evaluate((value) => {
        window.__rsviteDocument = value;
      }, sentinel);
      await expect(page.evaluate(() => window.__rsviteDocument)).resolves.toBe(sentinel);
      const navigationsBeforeEdit = navigations.length;
      const listening = listeningAgain(page);

      await edit({ root, page });

      await page.waitForFunction(() => window.__rsviteDocument === undefined, null, {
        timeout: 20_000,
      });
      expect(navigations.length).toBe(navigationsBeforeEdit + 1);

      await verify({ page });

      // One save is one document: the new page does not start the cycle again.
      await page.waitForTimeout(2_000);
      expect(navigations.length).toBe(navigationsBeforeEdit + 1);
      expect(errors).toEqual([]);
      // The next round only edits once this document is listening for saves itself.
      await listening;
    }

    // The same process kept serving the same address throughout.
    expect(child.exitCode).toBe(null);
    expect(page.url()).toBe(`${origin}/`);

    child.kill("SIGTERM");
    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    await provePortCanRebind(port);
  } finally {
    try {
      await browser?.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
}

test("an ordinary write to a JavaScript dependency reloads the open page by itself", async () => {
  await proveAutomaticReload({
    fixtureRoot: htmlFixtureRoot,
    rounds: [
      {
        edit: async ({ root }) => {
          const dependency = join(root, "src/message.js");
          const source = await readFile(dependency, "utf8");
          expect(source).toContain("served by Rust");
          await writeFile(dependency, source.replace("served by Rust", "saved by Rust"));
        },
        verify: async ({ page }) => {
          await expect(page.textContent("#app")).resolves.toBe("saved by Rust");
        },
      },
    ],
  });
});

test("an atomic replacement of a TypeScript dependency reloads the open page by itself", async () => {
  await proveAutomaticReload({
    fixtureRoot: typescriptFixtureRoot,
    rounds: [
      {
        edit: async ({ root }) => {
          await replaceAtomically(
            join(root, "src/message.ts"),
            'export const message: string = "replaced by Rust TypeScript";\n',
          );
        },
        verify: async ({ page }) => {
          await expect(page.textContent("#app")).resolves.toBe("replaced by Rust TypeScript");
        },
      },
    ],
  });
});

test("editing the asset and the stylesheet each reloads the open page on its own", async () => {
  await proveAutomaticReload({
    fixtureRoot: cssAssetFixtureRoot,
    rounds: [
      {
        // The asset alone, so its own acceptance by the watcher is what reloads the page.
        edit: async ({ root }) => {
          const asset = join(root, "assets/mark.svg");
          await writeFile(asset, (await readFile(asset, "utf8")).replace("circle", "ellipse"));
        },
        verify: async ({ page }) => {
          const asset = await page.evaluate(async () => (await fetch("/assets/mark.svg")).text());
          expect(asset).toContain("<ellipse");
          // The stylesheet has not been touched yet.
          await expect(
            page.evaluate(() => getComputedStyle(document.querySelector("#app")).color),
          ).resolves.toBe("rgb(16, 94, 160)");
        },
      },
      {
        edit: async ({ root }) => {
          const stylesheet = join(root, "src/styles.css");
          await writeFile(
            stylesheet,
            (await readFile(stylesheet, "utf8")).replace("rgb(16, 94, 160)", "rgb(3, 122, 51)"),
          );
        },
        verify: async ({ page }) => {
          await expect(
            page.evaluate(() => getComputedStyle(document.querySelector("#app")).color),
          ).resolves.toBe("rgb(3, 122, 51)");
        },
      },
    ],
  });
});

test("an atomic replacement of the root document reloads the open page by itself", async () => {
  await proveAutomaticReload({
    fixtureRoot: htmlFixtureRoot,
    rounds: [
      {
        edit: async ({ root }) => {
          const document = join(root, "index.html");
          const source = await readFile(document, "utf8");
          expect(source).toContain("rsvite M1 HTML");
          await replaceAtomically(
            document,
            source.replace("rsvite M1 HTML", "rsvite M1 HTML replaced"),
          );
        },
        verify: async ({ page }) => {
          await expect(page.title()).resolves.toBe("rsvite M1 HTML replaced");
          await expect(page.textContent("#app")).resolves.toBe("served by Rust");
        },
      },
    ],
  });
});

test("a save written in pieces through one handle reloads the page once", async () => {
  await proveAutomaticReload({
    fixtureRoot: htmlFixtureRoot,
    rounds: [
      {
        // One edit, one handle, several pieces. They belong to the same edit window, so the page
        // loads once and reads what the file holds at the end of it.
        edit: async ({ root }) => {
          const dependency = await open(join(root, "src/message.js"), "w");
          try {
            await dependency.write('export const message = "written in');
            await dependency.write(' pieces";\n');
            await dependency.sync();
          } finally {
            await dependency.close();
          }
        },
        verify: async ({ page }) => {
          await expect(page.textContent("#app")).resolves.toBe("written in pieces");
        },
      },
    ],
  });
});

test("activity outside the project does not delay a save inside it", async () => {
  const outside = await mkdtemp(join(tmpdir(), "rsvite-m1-outside-"));
  let noisy = true;
  try {
    await proveAutomaticReload({
      fixtureRoot: htmlFixtureRoot,
      prepare: async ({ root }) => {
        // A link the project contains, pointing at a directory it does not. Requests for what is
        // behind it are refused, so what happens there is not this server's business.
        await symlink(outside, join(root, "external"));
        void (async () => {
          while (noisy) {
            await writeFile(
              join(outside, "noise.js"),
              `export const noise = ${String(Date.now())};\n`,
            );
            await new Promise((wait) => setTimeout(wait, 20));
          }
        })();
      },
      rounds: [
        {
          edit: async ({ root }) => {
            const dependency = join(root, "src/message.js");
            const source = await readFile(dependency, "utf8");
            await writeFile(dependency, source.replace("served by Rust", "saved despite noise"));
          },
          verify: async ({ page }) => {
            await expect(page.textContent("#app")).resolves.toBe("saved despite noise");
          },
        },
      ],
    });
  } finally {
    noisy = false;
    await rm(outside, { recursive: true, force: true });
  }
});

test("a replacement written outside the project reloads the open page", async () => {
  const outside = await mkdtemp(join(tmpdir(), "rsvite-m1-outside-replacement-"));
  try {
    await proveAutomaticReload({
      fixtureRoot: htmlFixtureRoot,
      rounds: [
        {
          // The file is written and closed where the watcher cannot see it, then renamed onto the
          // dependency's name. All this server sees is the name coming to lead somewhere else.
          edit: async ({ root }) => {
            const pending = join(outside, "message.js.pending");
            await writeFile(pending, 'export const message = "written outside the project";\n');
            await rename(pending, join(root, "src/message.js"));
          },
          verify: async ({ page }) => {
            await expect(page.textContent("#app")).resolves.toBe("written outside the project");
          },
        },
      ],
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("a document outside the project reloads the open page when it changes", async () => {
  const outside = await mkdtemp(join(tmpdir(), "rsvite-m1-outside-document-"));
  try {
    const published = join(outside, "published.html");
    await proveAutomaticReload({
      fixtureRoot: htmlFixtureRoot,
      // `GET /` reads `index.html` wherever it leads, so the document a page is given can live
      // outside the project.
      prepare: async ({ root }) => {
        const document = join(root, "index.html");
        await writeFile(published, await readFile(document, "utf8"));
        await rm(document);
        await symlink(published, document);
      },
      rounds: [
        {
          edit: async () => {
            const html = await readFile(published, "utf8");
            await writeFile(published, html.replace('id="app"', 'id="app" data-outside="yes"'));
          },
          verify: async ({ page }) => {
            await expect(page.getAttribute("#app", "data-outside")).resolves.toBe("yes");
          },
        },
      ],
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
