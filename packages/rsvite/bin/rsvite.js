#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";
import { DevServer } from "../native.js";

const DEFAULT_PORT = 5173;
const DEFAULT_CONFIG_FILENAMES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
];

function usageError(message) {
  throw new Error(`${message}\nUsage: rsvite [root] [--port <port>]`);
}

export function parseArguments(argv) {
  let root;
  let port = DEFAULT_PORT;
  let hasExplicitPort = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "build" || argument === "preview") {
      usageError(`${argument} is not supported in the current compatibility level`);
    }
    if (argument === "--config" || argument.startsWith("--config=")) {
      usageError("--config is not supported in the current compatibility level");
    }
    if (argument === "--port") {
      const value = argv[index + 1];
      if (value === undefined) usageError("--port requires a value");
      port = parsePort(value);
      hasExplicitPort = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--port=")) {
      port = parsePort(argument.slice("--port=".length));
      hasExplicitPort = true;
      continue;
    }
    if (argument.startsWith("-")) usageError(`unknown option: ${argument}`);
    if (root !== undefined) usageError(`unexpected positional argument: ${argument}`);
    root = argument;
  }

  return { root: resolve(root ?? "."), port, hasExplicitPort };
}

function parsePort(value) {
  if (!/^[0-9]+$/.test(value)) usageError(`invalid port: ${value}`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    usageError(`invalid port: ${value}`);
  }
  return port;
}

function configurationError(message) {
  throw new Error(`invalid vite.config.js: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataProperty(object, key, location) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) return { present: false };
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    configurationError(`${location}.${key} must be a data property`);
  }
  return { present: true, value: descriptor.value };
}

function validateKeys(object, allowedKeys, location) {
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      configurationError(`${location} has unsupported key ${String(key)}`);
    }
    ownDataProperty(object, key, location);
  }
}

function observeExportedPromiseRejection(promise) {
  try {
    void Promise.prototype.then.call(promise, undefined, () => {});
  } catch {
    const onUnhandledRejection = (reason, rejectedPromise) => {
      if (rejectedPromise === promise) {
        process.off("unhandledRejection", onUnhandledRejection);
        return;
      }
      throw reason;
    };
    process.prependListener("unhandledRejection", onUnhandledRejection);
  }
}

function validateConfiguration(value) {
  if (typeof value === "function") {
    configurationError("must default-export a plain object, not a function");
  }
  if (types.isPromise(value)) {
    observeExportedPromiseRejection(value);
    configurationError("must default-export a plain object, not a Promise");
  }
  if (Array.isArray(value)) {
    configurationError("must default-export a plain object, not an array");
  }
  if (!isPlainObject(value)) {
    configurationError("must default-export a plain object");
  }

  validateKeys(value, ["server"], "configuration");
  const server = ownDataProperty(value, "server", "configuration");
  if (!server.present) return {};
  if (!isPlainObject(server.value)) {
    configurationError("configuration.server must be a plain object");
  }

  validateKeys(server.value, ["port"], "configuration.server");
  const port = ownDataProperty(server.value, "port", "configuration.server");
  if (!port.present) return {};
  if (!Number.isInteger(port.value) || port.value < 0 || port.value > 65535) {
    configurationError("configuration.server.port must be an integer from 0 through 65535");
  }
  return { port: port.value };
}

async function loadConfiguration(root) {
  const filename = DEFAULT_CONFIG_FILENAMES.find((candidate) =>
    existsSync(resolve(root, candidate)),
  );
  if (filename === undefined) return {};
  if (filename !== "vite.config.js") {
    throw new Error(`${filename} is not supported in the current compatibility level`);
  }

  let module;
  try {
    module = await import(pathToFileURL(resolve(root, filename)).href);
  } catch (error) {
    throw new Error(
      `failed to load ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateConfiguration(module.default);
}

export async function resolveStartOptions(argv) {
  const options = parseArguments(argv);
  const configuration = await loadConfiguration(options.root);
  return {
    root: options.root,
    port: options.hasExplicitPort ? options.port : (configuration.port ?? options.port),
  };
}

async function run(argv) {
  const options = await resolveStartOptions(argv);
  const server = await DevServer.start(options);

  const completion = new Promise((resolveRun, rejectRun) => {
    let closeStarted = false;
    const removeSignalHandlers = () => {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
    };
    const finish = (settle, value) => {
      removeSignalHandlers();
      settle(value);
    };
    const close = () => {
      if (closeStarted) return;
      closeStarted = true;
      void server.close().then(
        () => finish(resolveRun),
        (error) => finish(rejectRun, error),
      );
    };

    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    void server.wait().then(
      () => finish(resolveRun),
      (error) => finish(rejectRun, error),
    );
  });

  // `Local:` is the public readiness boundary. Both signal paths must already translate into
  // Rust-owned graceful shutdown before a parent can observe those bytes and interrupt us.
  process.stdout.write(`Local: http://${server.address}/\n`);
  await completion;
}

const invokedAsProgram =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedAsProgram) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`rsvite: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
