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
const nativePromiseThen = Object.getOwnPropertyDescriptor(Promise.prototype, "then").value;

function usageError(message) {
  throw new Error(`${message}\nUsage: rsvite [root] [--port <port>]`);
}

export function parseArguments(argv) {
  let root;
  let port;

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

function configurationError(message) {
  throw new Error(`invalid vite.config.js: ${message}`);
}

/**
 * The text a failure is reported with, in three steps.
 *
 * A string `message` is what the value says about itself, so it wins. Otherwise the value is
 * asked for its text form. Only a value that answers neither — one whose conversion throws — is
 * reported by a fixed description. Reading the message is asked separately from converting the
 * value, because a value that refuses to produce a message may still have a text form worth
 * reporting.
 */
function errorMessage(error) {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      const message = error.message;
      if (typeof message === "string") return message;
    } catch {
      // Asked and refused. What the value converts to is a separate question, asked next.
    }
  }
  try {
    return String(error);
  } catch {
    return "error value cannot be converted to text";
  }
}

function createConfigEnv() {
  return {
    command: "serve",
    mode: "development",
    isSsrBuild: false,
    isPreview: false,
  };
}

/**
 * Takes the rejection of a Promise this server was handed but will not use.
 *
 * A Promise that rejects with nobody listening ends the process. This server was given the value,
 * so it is the one that has to listen, even though the value itself is not something it accepts.
 * The handler taken at startup is used so a project's own `then` cannot decide what happens here.
 */
function takeRejection(promise) {
  void Reflect.apply(nativePromiseThen, promise, [undefined, () => {}]);
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

function validateConfiguration(value) {
  if (Array.isArray(value)) {
    configurationError("must default-export a plain object, not an array");
  }
  if (!isPlainObject(value)) {
    configurationError("must default-export a plain object");
  }

  validateKeys(value, ["server", "plugins"], "configuration");
  const plugin = validatePlugins(value);
  const server = ownDataProperty(value, "server", "configuration");
  if (!server.present) return { plugin };
  if (!isPlainObject(server.value)) {
    configurationError("configuration.server must be a plain object");
  }

  validateKeys(server.value, ["port"], "configuration.server");
  const port = ownDataProperty(server.value, "port", "configuration.server");
  if (!port.present) return { plugin };
  if (!Number.isInteger(port.value) || port.value < 0 || port.value > 65535) {
    configurationError("configuration.server.port must be an integer from 0 through 65535");
  }
  return { port: port.value, plugin };
}

/**
 * The one plugin this compatibility level accepts, or nothing.
 *
 * Every shape outside that one is refused by name rather than ignored, because a plugin silently
 * dropped is a project that believes its document is being transformed when it is not. The list
 * may be absent or empty; beyond that it holds exactly one plain object declaring exactly a name
 * and a pre-ordered `transformIndexHtml` handler.
 */
function validatePlugins(value) {
  const plugins = ownDataProperty(value, "plugins", "configuration");
  if (!plugins.present) return undefined;
  if (!Array.isArray(plugins.value)) {
    configurationError("configuration.plugins must be an array");
  }
  // The list is read the same way every other configuration value is: by what it holds, not by
  // what it computes when asked. A list that answers with a getter, or carries a key beyond its
  // own entries and length, is a shape this level refuses rather than one it quietly resolves.
  const length = ownDataProperty(plugins.value, "length", "configuration.plugins");
  if (!length.present || length.value > 1) {
    configurationError("configuration.plugins accepts at most one plugin");
  }
  validateKeys(
    plugins.value,
    length.value === 0 ? ["length"] : ["0", "length"],
    "configuration.plugins",
  );
  if (length.value === 0) return undefined;
  const entry = ownDataProperty(plugins.value, "0", "configuration.plugins").value;
  if (!isPlainObject(entry)) {
    configurationError("configuration.plugins[0] must be a plain object");
  }
  validateKeys(entry, ["name", "transformIndexHtml"], "configuration.plugins[0]");

  const name = ownDataProperty(entry, "name", "configuration.plugins[0]");
  if (!name.present || typeof name.value !== "string" || name.value === "") {
    configurationError("configuration.plugins[0].name must be a non-empty string");
  }

  const hook = ownDataProperty(entry, "transformIndexHtml", "configuration.plugins[0]");
  if (!hook.present || !isPlainObject(hook.value)) {
    configurationError(
      "configuration.plugins[0].transformIndexHtml must be an object with order and handler",
    );
  }
  validateKeys(hook.value, ["order", "handler"], "configuration.plugins[0].transformIndexHtml");
  const order = ownDataProperty(hook.value, "order", "configuration.plugins[0].transformIndexHtml");
  if (!order.present || order.value !== "pre") {
    configurationError('configuration.plugins[0].transformIndexHtml.order must be "pre"');
  }
  const handler = ownDataProperty(
    hook.value,
    "handler",
    "configuration.plugins[0].transformIndexHtml",
  );
  if (!handler.present || typeof handler.value !== "function") {
    configurationError("configuration.plugins[0].transformIndexHtml.handler must be a function");
  }
  return { name: name.value, handler: handler.value };
}

/**
 * The single call this server makes into project code for a root document.
 *
 * The hook is given the document as the project wrote it and the names a request reaches it by,
 * and nothing else: no plugin object, no configuration, and no context this compatibility level
 * does not support. Those names are built for each call, so what one request's hook does to what
 * it was given cannot decide what the next request's hook is given.
 *
 * A document comes back as text. A hook that throws, or answers with something this level does
 * not accept, fails that one request as one message naming the plugin; the caller of this turns
 * that into the response and goes on serving.
 */
function createTransformIndexHtml(root, plugin) {
  const filename = resolve(root, "index.html");
  return (html) => {
    let produced;
    try {
      produced = (0, plugin.handler)(html, { path: "/index.html", filename });
    } catch (error) {
      // A Promise is a value a hook may throw as well as return, and either way this server was
      // handed it. Its rejection is taken before the failure is reported, because a rejection
      // nobody listened for ends the process after the response has already been written.
      if (types.isPromise(error)) takeRejection(error);
      configurationFailure(
        `plugin ${plugin.name} failed to transform index.html: ${errorMessage(error)}`,
      );
    }
    // Saying nothing, and saying nothing in particular, both leave the document as it was.
    if (produced === undefined || produced === "") return html;
    if (typeof produced === "string") return produced;
    if (types.isPromise(produced)) takeRejection(produced);
    configurationFailure(`plugin ${plugin.name} must return a string or undefined`);
  };
}

/** One request's failure, said once, in the words the response carries. */
function configurationFailure(message) {
  throw new Error(message);
}

function configurationNamespaceImportUrl(url) {
  const source = [
    `import * as configuration from ${JSON.stringify(url)};`,
    "export default { configuration };",
    "",
  ].join("\n");
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function resolveConfigurationExport(value) {
  const exportedValue = typeof value === "function" ? value(createConfigEnv()) : value;
  if (!types.isPromise(exportedValue)) return { value: exportedValue };
  return new Promise((resolveConfiguration, rejectConfiguration) => {
    try {
      void Reflect.apply(nativePromiseThen, exportedValue, [
        (resolvedValue) => resolveConfiguration({ value: resolvedValue }),
        rejectConfiguration,
      ]);
    } catch (error) {
      rejectConfiguration(error);
    }
  });
}

async function loadConfiguration(root) {
  const filename = DEFAULT_CONFIG_FILENAMES.find((candidate) =>
    existsSync(resolve(root, candidate)),
  );
  if (filename === undefined) return {};
  if (filename !== "vite.config.js") {
    throw new Error(`${filename} is not supported in the current compatibility level`);
  }

  if (!process.env.NODE_ENV) process.env.NODE_ENV = "development";

  let module;
  try {
    const configurationUrl = pathToFileURL(resolve(root, filename)).href;
    const wrapper = await import(configurationNamespaceImportUrl(configurationUrl));
    module = wrapper.default.configuration;
  } catch (error) {
    throw new Error(`failed to load ${filename}: ${errorMessage(error)}`);
  }

  let resolvedValue;
  try {
    ({ value: resolvedValue } = await resolveConfigurationExport(module.default));
  } catch (error) {
    throw new Error(`failed to evaluate ${filename}: ${errorMessage(error)}`);
  }
  return validateConfiguration(resolvedValue);
}

export async function resolveStartOptions(argv) {
  const options = parseArguments(argv);
  const configuration = await loadConfiguration(options.root);
  return {
    root: options.root,
    port: options.port ?? configuration.port ?? DEFAULT_PORT,
    transformIndexHtml:
      configuration.plugin === undefined
        ? undefined
        : createTransformIndexHtml(options.root, configuration.plugin),
  };
}

async function run(options) {
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

  // `Local:` is written after the signal handlers are registered, so a signal received after
  // readiness closes the Rust server gracefully.
  process.stdout.write(`Local: http://${server.address}/\n`);
  await completion;
}

async function writeFailure(error) {
  const message = `rsvite: ${error instanceof Error ? error.message : String(error)}\n`;
  await new Promise((resolveWrite) => process.stderr.write(message, resolveWrite));
}

const invokedAsProgram =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
async function main(argv) {
  try {
    await run(await resolveStartOptions(argv));
  } catch (error) {
    await writeFailure(error);
    process.exit(1);
    return;
  }
  process.exit(0);
}

if (invokedAsProgram) await main(process.argv.slice(2));
