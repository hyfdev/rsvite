import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { resolveStartOptions } from "../bin/rsvite.js";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../..");
const rsviteBin = join(packageRoot, "bin/rsvite.js");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(files = {}) {
  const root = await mkdtemp(join(tmpdir(), "rsvite-static-config-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "index.html"), "<h1>static config</h1>");
  await Promise.all(
    Object.entries(files).map(([filename, contents]) => writeFile(join(root, filename), contents)),
  );
  return root;
}

function startCli(root, arguments_ = []) {
  return spawn(process.execPath, [rsviteBin, root, ...arguments_], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function waitForExitWithin(exit, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      exit,
      new Promise((_, rejectExit) => {
        timer = setTimeout(
          () => rejectExit(new Error("CLI did not exit before the timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function waitForReadiness(child) {
  return new Promise((resolveAddress, rejectAddress) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    const timer = setTimeout(
      () => finish(rejectAddress, new Error(`server did not start:\n${stderr}`)),
      10_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/Local: http:\/\/(127\.0\.0\.1:(\d+))\//);
      if (match !== null) {
        finish(resolveAddress, { origin: `http://${match[1]}`, port: Number(match[2]) });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => finish(rejectAddress, error));
    child.once("exit", (code, signal) => {
      finish(
        rejectAddress,
        new Error(
          `server exited before readiness: code=${String(code)} signal=${String(signal)}\n${stderr}`,
        ),
      );
    });
  });
}

function runCli(root, arguments_ = [], timeoutMs = 10_000) {
  const child = startCli(root, arguments_);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolveRun, rejectRun) => {
    const finish = (settle, value) => {
      clearTimeout(timer);
      settle(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(rejectRun, new Error(`CLI did not exit:\n${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => finish(rejectRun, error));
    child.once("exit", (code, signal) => finish(resolveRun, { code, signal, stdout, stderr }));
  });
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  return address.port;
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

async function listenOn(port) {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return server;
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`configuration did not begin evaluating: ${file}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function expectServing(root, arguments_, expectedPort, exitTimeoutMs = 10_000) {
  const child = startCli(root, arguments_);
  const exit = waitForExit(child);
  let port;
  try {
    const readiness = await waitForReadiness(child);
    port = readiness.port;
    if (expectedPort !== undefined) expect(port).toBe(expectedPort);
    const rootHtml = await fetch(`${readiness.origin}/`).then((response) => response.text());
    expect(rootHtml).toContain("<h1>static config</h1>");
    expect(child.kill("SIGTERM")).toBe(true);
    await expect(waitForExitWithin(exit, exitTimeoutMs)).resolves.toEqual({
      code: 0,
      signal: null,
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit.catch(() => undefined);
    if (port !== undefined) await provePortCanRebind(port);
  }
  return port;
}

async function expectConfigurationFailure({
  filename = "vite.config.js",
  source,
  message,
  timeoutMs,
}) {
  const port = await findAvailablePort();
  const root = await createFixture({
    "package.json": '{"type":"module"}\n',
    [filename]: source,
  });
  const result = await runCli(root, ["--port", String(port)], timeoutMs);
  expect(result).toMatchObject({ code: 1, signal: null });
  expect(result.stdout).not.toContain("Local:");
  expect(result.stderr).toContain(message);
  expect(result.stderr.match(/rsvite:/g)).toHaveLength(1);
  await provePortCanRebind(port);
  return result;
}

describe("static Vite configuration", () => {
  test.each([
    ["ESM default export", "export default { server: { port: PORT } };\n"],
    ["CommonJS module.exports", "module.exports = { server: { port: PORT } };\n"],
  ])("loads %s and starts the Rust-owned server", async (kind, source) => {
    const port = await findAvailablePort();
    const root = await createFixture({
      "package.json":
        kind === "ESM default export" ? '{"type":"module"}\n' : '{"type":"commonjs"}\n',
      "vite.config.js": source.replace("PORT", String(port)),
    });

    await expectServing(root, [], port);
  });

  test("uses vite.config.js before later standard default candidates", async () => {
    const port = await findAvailablePort();
    const root = await createFixture({
      "package.json": '{"type":"module"}\n',
      "vite.config.js": `export default { server: { port: ${String(port)} } };\n`,
      "vite.config.ts": "throw new Error('later candidate was loaded');\n",
    });

    await expectServing(root, [], port);
  });

  test("uses a configured ephemeral port", async () => {
    const root = await createFixture({
      "package.json": '{"type":"module"}\n',
      "vite.config.js": "export default { server: { port: 0 } };\n",
    });

    const defaultPort = await listenOn(5173);
    try {
      await expect(resolveStartOptions([root])).resolves.toEqual({ root, port: 0 });
      expect(await expectServing(root, [], undefined)).toBeGreaterThan(0);
    } finally {
      await closeServer(defaultPort);
    }
  });

  test("lets an explicit ephemeral port override a configured port", async () => {
    const defaultPort = await listenOn(5173);
    const configuredPort = await findAvailablePort();
    const occupied = await listenOn(configuredPort);
    const root = await createFixture({
      "package.json": '{"type":"module"}\n',
      "vite.config.js": `export default { server: { port: ${String(configuredPort)} } };\n`,
    });

    try {
      await expect(resolveStartOptions([root, "--port", "0"])).resolves.toEqual({
        root,
        port: 0,
      });
      const actualPort = await expectServing(root, ["--port", "0"], undefined);
      expect(actualPort).not.toBe(configuredPort);
    } finally {
      await closeServer(occupied);
      await closeServer(defaultPort);
    }
  });

  test("uses the default port for no config and explicit port behavior", async () => {
    const root = await createFixture();
    await expect(resolveStartOptions([root])).resolves.toEqual({ root, port: 5173 });
    const emptyConfigurationRoot = await createFixture({
      "package.json": '{"type":"module"}\n',
      "vite.config.js": "export default {};\n",
    });
    await expect(resolveStartOptions([emptyConfigurationRoot])).resolves.toEqual({
      root: emptyConfigurationRoot,
      port: 5173,
    });
    const serverWithoutPortRoot = await createFixture({
      "package.json": '{"type":"module"}\n',
      "vite.config.js": "export default { server: {} };\n",
    });
    await expect(resolveStartOptions([serverWithoutPortRoot])).resolves.toEqual({
      root: serverWithoutPortRoot,
      port: 5173,
    });
    expect(await expectServing(root, ["--port", "0"], undefined)).toBeGreaterThan(0);
  });

  test("reports a configured busy port without leaving a listener", async () => {
    const port = await findAvailablePort();
    const occupied = await listenOn(port);
    const root = await createFixture({
      "package.json": '{"type":"module"}\n',
      "vite.config.js": [
        "setInterval(() => {}, 60_000);",
        `export default { server: { port: ${String(port)} } };`,
        "",
      ].join("\n"),
    });

    try {
      const result = await runCli(root, [], 3_000);
      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.stdout).not.toContain("Local:");
      expect(result.stderr).toContain(`failed to bind 127.0.0.1:${String(port)}`);
      expect(result.stderr.match(/rsvite:/g)).toHaveLength(1);
    } finally {
      await closeServer(occupied);
    }
    await provePortCanRebind(port);
  });

  test("closes after SIGTERM when configuration retains an interval", async () => {
    const root = await createFixture({
      "package.json": '{"type":"module"}\n',
      "vite.config.js": [
        "setInterval(() => {}, 60_000);",
        "export default { server: { port: 0 } };",
        "",
      ].join("\n"),
    });

    expect(await expectServing(root, [], undefined, 3_000)).toBeGreaterThan(0);
  });

  test.each([
    ["configuration function", "export default () => ({});\n", "not a function"],
    ["configuration Promise", "export default Promise.resolve({});\n", "not a Promise"],
    ["configuration array", "export default [];\n", "not an array"],
    ["null configuration", "export default null;\n", "must default-export a plain object"],
    ["numeric configuration", "export default 5173;\n", "must default-export a plain object"],
    ["class-instance configuration", "export default new (class Config {})();\n", "plain object"],
    ["unknown top-level key", "export default { base: '/' };\n", "unsupported key base"],
    [
      "non-object server",
      "export default { server: [] };\n",
      "configuration.server must be a plain object",
    ],
    [
      "unknown server key",
      "export default { server: { host: '127.0.0.1' } };\n",
      "unsupported key host",
    ],
    ["negative port", "export default { server: { port: -1 } };\n", "must be an integer"],
    ["fractional port", "export default { server: { port: 1.5 } };\n", "must be an integer"],
    ["out-of-range port", "export default { server: { port: 65536 } };\n", "must be an integer"],
    ["string port", "export default { server: { port: '5173' } };\n", "must be an integer"],
    ["undefined port", "export default { server: { port: undefined } };\n", "must be an integer"],
  ])("rejects %s before starting Rust", async (_kind, source, message) => {
    await expectConfigurationFailure({ source, message });
  });

  test.each([
    [
      "an immediately rejected Promise",
      "export default Promise.reject(new Error('rejected config Promise'));\n",
    ],
    [
      "a delayed rejected Promise",
      "export default new Promise((resolve, reject) => setTimeout(() => reject(new Error('delayed rejected config Promise')), 0));\n",
    ],
    [
      "a rejected foreign-realm Promise",
      [
        'import vm from "node:vm";',
        `export default vm.runInNewContext("Promise.reject(new Error('foreign-realm rejected config Promise'))");`,
        "",
      ].join("\n"),
    ],
    [
      "a rejected Promise with a shadowed catch",
      [
        `const promise = Promise.reject(new Error("shadowed catch config Promise"));`,
        `Object.defineProperty(promise, "catch", { value: () => undefined });`,
        "export default promise;",
        "",
      ].join("\n"),
    ],
    ["a pending Promise", "export default new Promise(() => {});\n", 1_000],
  ])("rejects %s with one CLI diagnostic", async (_kind, source, timeoutMs) => {
    const result = await expectConfigurationFailure({
      source,
      message: "not a Promise",
      timeoutMs,
    });

    expect(result.stderr).toBe(
      "rsvite: invalid vite.config.js: must default-export a plain object, not a Promise\n",
    );
  });

  test.each([
    [
      "a rejected Promise retaining a timer",
      [
        "setTimeout(() => {}, 60_000);",
        `export default Promise.reject(new Error("timer config Promise"));`,
        "",
      ].join("\n"),
    ],
    [
      "a resolved Promise retaining an interval",
      ["setInterval(() => {}, 60_000);", "export default Promise.resolve({});", ""].join("\n"),
    ],
  ])("rejects %s without waiting for its referenced resource", async (_kind, source) => {
    const result = await expectConfigurationFailure({
      source,
      message: "not a Promise",
      timeoutMs: 3_000,
    });

    expect(result.stderr).toBe(
      "rsvite: invalid vite.config.js: must default-export a plain object, not a Promise\n",
    );
  });

  test.each([
    "vite.config.mjs",
    "vite.config.ts",
    "vite.config.cjs",
    "vite.config.mts",
    "vite.config.cts",
  ])("rejects unsupported default file %s", async (filename) => {
    await expectConfigurationFailure({
      filename,
      source: "export default {};\n",
      message: `${filename} is not supported`,
    });
  });

  test("reports a configuration load exception even with an explicit port", async () => {
    await expectConfigurationFailure({
      source: "throw new Error('configuration exploded');\n",
      message: "configuration exploded",
    });
  });

  test("validates a delayed configuration before starting Rust", async () => {
    const port = await findAvailablePort();
    const root = await createFixture({ "package.json": '{"type":"module"}\n' });
    const marker = join(root, "configuration-evaluating");
    await writeFile(
      join(root, "vite.config.js"),
      [
        'import { writeFile } from "node:fs/promises";',
        `await writeFile(${JSON.stringify(marker)}, "evaluating\\n");`,
        "await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));",
        'export default { server: { port: "invalid" } };',
        "",
      ].join("\n"),
    );

    const child = startCli(root, ["--port", String(port)]);
    const exit = waitForExit(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);

    try {
      await waitForFile(marker);
      await provePortCanRebind(port);
      await expect(exit).resolves.toEqual({ code: 1, signal: null });
      expect(stdout).not.toContain("Local:");
      expect(stderr).toBe(
        "rsvite: invalid vite.config.js: configuration.server.port must be an integer from 0 through 65535\n",
      );
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit.catch(() => undefined);
    }
  });
});
