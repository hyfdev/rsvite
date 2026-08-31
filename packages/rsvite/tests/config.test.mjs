import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "rsvite-config-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "index.html"), "<h1>config</h1>");
  await Promise.all(
    Object.entries(files).map(([filename, contents]) => writeFile(join(root, filename), contents)),
  );
  return root;
}

function startCli(root, arguments_ = [], environment) {
  return spawn(process.execPath, [rsviteBin, root, ...arguments_], {
    cwd: repositoryRoot,
    env: environment,
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

function environmentWithNodeEnv(value) {
  const environment = { ...process.env };
  if (value === undefined) {
    delete environment.NODE_ENV;
  } else {
    environment.NODE_ENV = value;
  }
  return environment;
}

async function expectServing(root, arguments_, expectedPort, exitTimeoutMs = 10_000, environment) {
  const child = startCli(root, arguments_, environment);
  const exit = waitForExit(child);
  let port;
  try {
    const readiness = await waitForReadiness(child);
    port = readiness.port;
    if (expectedPort !== undefined) expect(port).toBe(expectedPort);
    const rootHtml = await fetch(`${readiness.origin}/`).then((response) => response.text());
    expect(rootHtml).toContain("<h1>config</h1>");
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

async function expectConfigurationFailure({ filename = "vite.config.js", source, message }) {
  const port = await findAvailablePort();
  const occupied = await listenOn(port);
  const root = await createFixture({
    "package.json": '{"type":"module"}\n',
    [filename]: source,
  });
  let result;
  try {
    result = await runCli(root, ["--port", String(port)]);
  } finally {
    await closeServer(occupied);
  }
  expect(result).toMatchObject({ code: 1, signal: null });
  expect(result.stdout).not.toContain("Local:");
  expect(result.stderr).toContain(message);
  expect(result.stderr.match(/rsvite:/g)).toHaveLength(1);
  await provePortCanRebind(port);
  return result;
}

async function expectNativeUnhandledRejection(root, message) {
  const result = await runCli(root);
  expect(result).toMatchObject({ code: 1, signal: null });
  expect(result.stdout).not.toContain("Local:");
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain("rsvite:");
  return result;
}

describe("C1 Vite configuration", () => {
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

  test.each([
    [
      "an ESM Promise export",
      '{"type":"module"}\n',
      "export default Promise.resolve({ server: { port: PORT } });\n",
    ],
    [
      "a CommonJS Promise export",
      '{"type":"commonjs"}\n',
      "module.exports = Promise.resolve({ server: { port: PORT } });\n",
    ],
  ])("resolves %s before starting the Rust-owned server", async (_kind, packageJson, source) => {
    const port = await findAvailablePort();
    const root = await createFixture({
      "package.json": packageJson,
      "vite.config.js": source.replace("PORT", String(port)),
    });

    await expectServing(root, [], port);
  });

  test.each([
    ["ESM synchronous function", '{"type":"module"}\n', "export default function config"],
    ["CommonJS synchronous function", '{"type":"commonjs"}\n', "module.exports = function config"],
    ["ESM async function", '{"type":"module"}\n', "export default async function config"],
    ["CommonJS async function", '{"type":"commonjs"}\n', "module.exports = async function config"],
  ])(
    "evaluates and invokes an %s config once with the Vite development ConfigEnv",
    async (kind, packageJson, export_) => {
      const port = await findAvailablePort();
      const root = await createFixture({ "package.json": packageJson });
      const observation = join(root, "function-observation.json");
      await writeFile(
        join(root, "vite.config.js"),
        [
          kind.startsWith("CommonJS")
            ? 'const { appendFileSync } = require("node:fs");'
            : 'import { appendFileSync } from "node:fs";',
          `appendFileSync(${JSON.stringify(observation)}, JSON.stringify({ event: "evaluate", nodeEnv: process.env.NODE_ENV }) + "\\n");`,
          `${export_}(environment) {`,
          `  appendFileSync(${JSON.stringify(observation)}, JSON.stringify({ event: "invoke", environment, nodeEnv: process.env.NODE_ENV }) + "\\n");`,
          `  return { server: { port: ${String(port)} } };`,
          "}",
          "",
        ].join("\n"),
      );

      await expectServing(root, [], port, 10_000, environmentWithNodeEnv(undefined));
      await expect(readFile(observation, "utf8")).resolves.toBe(
        [
          JSON.stringify({ event: "evaluate", nodeEnv: "development" }),
          JSON.stringify({
            event: "invoke",
            environment: {
              command: "serve",
              mode: "development",
              isSsrBuild: false,
              isPreview: false,
            },
            nodeEnv: "development",
          }),
          "",
        ].join("\n"),
      );
    },
  );

  test.each([
    ["ESM direct object", "development", "module", "direct", undefined],
    ["CommonJS direct object", "development", "commonjs", "direct", ""],
    ["ESM direct object", "production", "module", "direct", "production"],
    ["ESM function", "development", "module", "function", undefined],
    ["CommonJS function", "development", "commonjs", "function", ""],
    ["ESM function", "production", "module", "function", "production"],
  ])(
    "lets %s config observe NODE_ENV %s",
    async (_kind, expectedNodeEnv, packageType, exportKind, nodeEnv) => {
      const port = await findAvailablePort();
      const root = await createFixture({ "package.json": `{"type":"${packageType}"}\n` });
      const observation = join(root, "node-env-observation");
      const importStatement =
        packageType === "module"
          ? 'import { writeFileSync } from "node:fs";'
          : 'const { writeFileSync } = require("node:fs");';
      const assignment = packageType === "module" ? "export default" : "module.exports =";
      const source =
        exportKind === "function"
          ? [
              importStatement,
              `${assignment} function config() {`,
              `  writeFileSync(${JSON.stringify(observation)}, process.env.NODE_ENV);`,
              `  return { server: { port: ${String(port)} } };`,
              "};",
              "",
            ].join("\n")
          : [
              importStatement,
              `writeFileSync(${JSON.stringify(observation)}, process.env.NODE_ENV);`,
              `${assignment} { server: { port: ${String(port)} } };`,
              "",
            ].join("\n");
      await writeFile(join(root, "vite.config.js"), source);

      await expectServing(root, [], port, 10_000, environmentWithNodeEnv(nodeEnv));
      await expect(readFile(observation, "utf8")).resolves.toBe(expectedNodeEnv);
    },
  );

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

  test("evaluates a function once before an explicit port overrides its resolved value", async () => {
    const explicitPort = await findAvailablePort();
    const root = await createFixture({ "package.json": '{"type":"module"}\n' });
    const observation = join(root, "override-function-calls");
    await writeFile(
      join(root, "vite.config.js"),
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(observation)}, "evaluate\\n");`,
        "export default function config() {",
        `  appendFileSync(${JSON.stringify(observation)}, "invoke\\n");`,
        "  return { server: { port: 0 } };",
        "}",
        "",
      ].join("\n"),
    );

    await expectServing(root, ["--port", String(explicitPort)], explicitPort);
    await expect(readFile(observation, "utf8")).resolves.toBe("evaluate\ninvoke\n");
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
    ["configuration array", "export default [];\n", "not an array"],
    ["null configuration", "export default null;\n", "must default-export a plain object"],
    ["numeric configuration", "export default 5173;\n", "must default-export a plain object"],
    ["class-instance configuration", "export default new (class Config {})();\n", "plain object"],
    [
      "plain object with an own then key",
      "export default { then(resolve) { resolve({ server: { port: 0 } }); } };\n",
      "unsupported key then",
    ],
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
    ["an ESM named export", '{"type":"module"}\n', "unsupported key base"],
    ["a CommonJS own export", '{"type":"commonjs"}\n', "unsupported key then"],
  ])(
    "does not execute callable then from %s before validating the real export",
    async (kind, packageJson, message) => {
      const root = await createFixture({ "package.json": packageJson });
      const marker = join(root, "namespace-then-called");
      const source =
        kind === "an ESM named export"
          ? [
              'import { writeFileSync } from "node:fs";',
              'export default { base: "/" };',
              "export function then(resolveThen) {",
              `  writeFileSync(${JSON.stringify(marker)}, "called\\n");`,
              "  resolveThen({ default: { server: { port: 0 } } });",
              "}",
              "",
            ].join("\n")
          : [
              'const { writeFileSync } = require("node:fs");',
              "module.exports = {",
              "  then(resolveThen) {",
              `    writeFileSync(${JSON.stringify(marker)}, "called\\n");`,
              "    resolveThen({ default: { server: { port: 0 } } });",
              "  },",
              "};",
              "",
            ].join("\n");
      await writeFile(join(root, "vite.config.js"), source);

      const result = await runCli(root);

      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.stdout).not.toContain("Local:");
      expect(result.stderr).toContain(message);
      expect(result.stderr.match(/rsvite:/g)).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
    },
  );

  test("lets Node stop an early direct Promise rejection before module evaluation continues", async () => {
    const root = await createFixture({ "package.json": '{"type":"module"}\n' });
    const marker = join(root, "early-direct-after-await");
    await writeFile(
      join(root, "vite.config.js"),
      [
        'import { writeFileSync } from "node:fs";',
        "const config = Promise.reject(new Error('early direct config rejection'));",
        "await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));",
        `writeFileSync(${JSON.stringify(marker)}, "continued\\n");`,
        "export default config;",
        "",
      ].join("\n"),
    );

    await expectNativeUnhandledRejection(root, "early direct config rejection");
    expect(existsSync(marker)).toBe(false);
  });

  test("lets Node stop an unrelated early rejection before module evaluation continues", async () => {
    const root = await createFixture({ "package.json": '{"type":"module"}\n' });
    const marker = join(root, "unrelated-early-after-await");
    await writeFile(
      join(root, "vite.config.js"),
      [
        'import { writeFileSync } from "node:fs";',
        "Promise.reject(new Error('unrelated config rejection'));",
        "await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));",
        `writeFileSync(${JSON.stringify(marker)}, "continued\\n");`,
        "export default { server: { port: 0 } };",
        "",
      ].join("\n"),
    );

    await expectNativeUnhandledRejection(root, "unrelated config rejection");
    expect(existsSync(marker)).toBe(false);
  });

  test("lets Node stop an early function-internal rejection before invocation continues", async () => {
    const root = await createFixture({ "package.json": '{"type":"module"}\n' });
    const marker = join(root, "early-function-after-await");
    await writeFile(
      join(root, "vite.config.js"),
      [
        'import { writeFileSync } from "node:fs";',
        "export default async function config() {",
        "  const value = Promise.reject(new Error('early function config rejection'));",
        "  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));",
        `  writeFileSync(${JSON.stringify(marker)}, "continued\\n");`,
        "  return value;",
        "}",
        "",
      ].join("\n"),
    );

    await expectNativeUnhandledRejection(root, "early function config rejection");
    expect(existsSync(marker)).toBe(false);
  });

  test("reports a handler-registration TypeError for a direct rejected Promise with an own invalid constructor", async () => {
    const result = await expectConfigurationFailure({
      source: [
        "const value = Promise.reject(new Error('own constructor config rejection'));",
        'Object.defineProperty(value, "constructor", { value: 0 });',
        "export default value;",
        "",
      ].join("\n"),
      message: "The .constructor property is not an object",
    });

    expect(result.stderr).toBe(
      "rsvite: failed to evaluate vite.config.js: The .constructor property is not an object\n",
    );
  });

  test("reports a handler-registration TypeError for a function result with an own invalid constructor", async () => {
    const result = await expectConfigurationFailure({
      source: [
        "export default function config() {",
        "  const value = Promise.reject(new Error('function result rejection'));",
        '  Object.defineProperty(value, "constructor", { value: 0 });',
        "  return value;",
        "}",
        "",
      ].join("\n"),
      message: "The .constructor property is not an object",
    });

    expect(result.stderr).toBe(
      "rsvite: failed to evaluate vite.config.js: The .constructor property is not an object\n",
    );
  });

  test("retains the reason from a cross-realm rejected Promise", async () => {
    const result = await expectConfigurationFailure({
      source: [
        'import { runInNewContext } from "node:vm";',
        "export default runInNewContext(\"Promise.reject(new Error('cross-realm config rejection'))\");",
        "",
      ].join("\n"),
      message: "cross-realm config rejection",
    });

    expect(result.stderr).toBe(
      "rsvite: failed to evaluate vite.config.js: cross-realm config rejection\n",
    );
  });

  test("does not execute then from a cross-realm rejected Promise", async () => {
    const root = await createFixture({ "package.json": '{"type":"module"}\n' });
    const marker = join(root, "cross-realm-then-called");
    await writeFile(
      join(root, "vite.config.js"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { runInNewContext } from "node:vm";',
        "const value = runInNewContext(\"Promise.reject(new Error('cross-realm own then rejection'))\");",
        'Object.defineProperty(value, "then", {',
        "  value(resolveThen) {",
        `    writeFileSync(${JSON.stringify(marker)}, "called\\n");`,
        "    resolveThen({ server: { port: 0 } });",
        "  },",
        "});",
        "export default value;",
        "",
      ].join("\n"),
    );

    const port = await findAvailablePort();
    const occupied = await listenOn(port);
    let result;
    try {
      result = await runCli(root, ["--port", String(port)]);
    } finally {
      await closeServer(occupied);
    }

    expect(result).toMatchObject({ code: 1, signal: null });
    expect(result.stdout).not.toContain("Local:");
    expect(result.stderr).toBe(
      "rsvite: failed to evaluate vite.config.js: cross-realm own then rejection\n",
    );
    expect(existsSync(marker)).toBe(false);
    await provePortCanRebind(port);
  });

  test("uses the startup Promise handler after config code replaces Promise.prototype.then", async () => {
    const root = await createFixture({ "package.json": '{"type":"module"}\n' });
    const marker = join(root, "replaced-promise-then-called");
    const source = [
      'import { writeFileSync } from "node:fs";',
      'const value = Promise.resolve({ base: "/" });',
      "Promise.prototype.then = function replacedThen(onFulfilled) {",
      `  writeFileSync(${JSON.stringify(marker)}, "called\\n");`,
      "  return onFulfilled({ server: { port: 0 } });",
      "};",
      "export default value;",
      "",
    ].join("\n");

    const result = await expectConfigurationFailure({
      source,
      message: "unsupported key base",
    });

    expect(result.stderr).toBe(
      "rsvite: invalid vite.config.js: configuration has unsupported key base\n",
    );
    expect(existsSync(marker)).toBe(false);
  });

  test.each([
    [
      "a direct rejected Promise",
      "export default Promise.reject(new Error('direct config rejection'));\n",
      "direct config rejection",
    ],
    [
      "a throwing function",
      "export default function config() { throw new Error('thrown function config'); }\n",
      "thrown function config",
    ],
    [
      "a rejecting async function",
      "export default async function config() { throw new Error('rejected async function config'); }\n",
      "rejected async function config",
    ],
  ])("reports %s under an explicit port with one diagnostic", async (_kind, source, message) => {
    const result = await expectConfigurationFailure({ source, message });

    expect(result.stderr).toBe(`rsvite: failed to evaluate vite.config.js: ${message}\n`);
  });

  test.each([
    [
      "a thrown null-prototype object",
      "export default function config() { throw Object.create(null); }\n",
    ],
    [
      "a handed rejected null-prototype object",
      "export default Promise.reject(Object.create(null));\n",
    ],
  ])("reports %s with a complete configuration path", async (_kind, source) => {
    const result = await expectConfigurationFailure({
      source,
      message: "failed to evaluate vite.config.js: error value cannot be converted to text",
    });

    expect(result.stderr).toBe(
      "rsvite: failed to evaluate vite.config.js: error value cannot be converted to text\n",
    );
  });

  test("rejects a function result that is not a configuration object under an explicit port", async () => {
    await expectConfigurationFailure({
      source: "export default function config() { return []; }\n",
      message: "invalid vite.config.js: must default-export a plain object, not an array",
    });
  });

  test("validates a dynamically resolved configuration before applying an explicit port", async () => {
    await expectConfigurationFailure({
      source: [
        "export default async function config() {",
        '  return { server: { port: "invalid" } };',
        "}",
        "",
      ].join("\n"),
      message: "configuration.server.port must be an integer from 0 through 65535",
    });
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

  test("validates a delayed function result before starting Rust", async () => {
    const port = await findAvailablePort();
    const occupied = await listenOn(port);
    const root = await createFixture({ "package.json": '{"type":"module"}\n' });
    const marker = join(root, "configuration-evaluating");
    await writeFile(
      join(root, "vite.config.js"),
      [
        'import { writeFile } from "node:fs/promises";',
        "export default async function config() {",
        `  await writeFile(${JSON.stringify(marker)}, "evaluating\\n");`,
        "  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));",
        '  return { server: { port: "invalid" } };',
        "}",
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
      await expect(exit).resolves.toEqual({ code: 1, signal: null });
      expect(stdout).not.toContain("Local:");
      expect(stderr).toBe(
        "rsvite: invalid vite.config.js: configuration.server.port must be an integer from 0 through 65535\n",
      );
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit.catch(() => undefined);
      await closeServer(occupied);
    }
    await provePortCanRebind(port);
  });
});
