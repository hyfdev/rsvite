#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevServer } from "../native.js";

const DEFAULT_PORT = 5173;

function usageError(message) {
  throw new Error(`${message}\nUsage: rsvite [root] [--port <port>]`);
}

export function parseArguments(argv) {
  let root;
  let port = DEFAULT_PORT;

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
      index += 1;
      continue;
    }
    if (argument.startsWith("--port=")) {
      port = parsePort(argument.slice("--port=".length));
      continue;
    }
    if (argument.startsWith("-")) usageError(`unknown option: ${argument}`);
    if (root !== undefined) usageError(`unexpected positional argument: ${argument}`);
    root = argument;
  }

  return { root: resolve(root ?? "."), port };
}

function parsePort(value) {
  if (!/^[0-9]+$/.test(value)) usageError(`invalid port: ${value}`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    usageError(`invalid port: ${value}`);
  }
  return port;
}

async function run(argv) {
  const options = parseArguments(argv);
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
