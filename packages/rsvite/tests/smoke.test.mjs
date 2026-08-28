import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

    const dependencyFile = join(root, dependencyPath);
    const first = await readFile(dependencyFile, "utf8");
    expect(first).toContain(initialText);
    await writeFile(dependencyFile, first.replace(initialText, updatedText));
    const reloadedDependency = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === dependencyPath,
    );
    await page.reload();
    expect((await reloadedDependency).status()).toBe(200);
    await expect(page.textContent("#app")).resolves.toBe(updatedText);
    expect(errors).toEqual([]);

    if (rejectedEntrySource !== undefined) {
      await writeFile(join(root, entryPath), rejectedEntrySource);
      const rejectedEntryResponse = page.waitForResponse(
        (candidate) => new URL(candidate.url()).pathname === entryPath,
      );
      await page.reload();
      expect((await rejectedEntryResponse).status()).toBe(400);
      await expect(page.textContent("#app")).resolves.toBe("loading");
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
