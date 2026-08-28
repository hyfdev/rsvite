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
const fixtureRoot = resolve(repositoryRoot, "fixtures/m1-basic-html");

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

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`the first readiness bytes already guarantee clean ${signal} shutdown`, async () => {
    const root = await mkdtemp(join(tmpdir(), "rsvite-m1-readiness-"));
    await cp(resolve(fixtureRoot, "index.html"), join(root, "index.html"));
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
  const root = await mkdtemp(join(tmpdir(), "rsvite-m1-html-"));
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

    const mainModuleResponse = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/src/main.js",
    );
    const dependencyResponse = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/src/message.js",
    );
    const response = await page.goto(`${origin}/`);
    const mainModule = await mainModuleResponse;
    const dependency = await dependencyResponse;
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-type"]).toBe("text/html; charset=utf-8");
    expect(mainModule.status()).toBe(200);
    expect(mainModule.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(mainModule.headers()["cache-control"]).toBe("no-store");
    const transformedMain = await mainModule.text();
    expect(transformedMain).toContain('from "/src/message.js"');
    expect(transformedMain).not.toContain('from "./message"');
    expect(dependency.status()).toBe(200);
    await expect(page.title()).resolves.toBe("rsvite M1 HTML");
    await expect(page.textContent("#app")).resolves.toBe("served by Rust");
    expect(errors).toEqual([]);

    const messagePath = join(root, "src/message.js");
    const first = await readFile(messagePath, "utf8");
    await writeFile(messagePath, first.replace("served by Rust", "served by Rust again"));
    const reloadedDependency = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/src/message.js",
    );
    await page.reload();
    expect((await reloadedDependency).status()).toBe(200);
    await expect(page.textContent("#app")).resolves.toBe("served by Rust again");
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
