import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../..");
const rsviteBin = join(packageRoot, "bin/rsvite.js");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A project whose document is a fragment, so a wrapping hook is visible in the response. */
async function createFixture({ document = '<div id="app">fragment</div>', ...files } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rsvite-plugins-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "index.html"), document);
  await Promise.all(
    Object.entries(files).map(([filename, contents]) => writeFile(join(root, filename), contents)),
  );
  return root;
}

/** The accepted declaration, with only the handler body differing between cases. */
function configurationDeclaring(handler, { module = "esm" } = {}) {
  const declaration = `{ server: { port: 0 }, plugins: [ { name: "wrap", transformIndexHtml: { order: "pre", handler: ${handler} } } ] }`;
  return module === "esm"
    ? `export default ${declaration};\n`
    : `module.exports = ${declaration};\n`;
}

function startCli(root) {
  return spawn(process.execPath, [rsviteBin, root], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A running server, with everything it has said so far available to the test. */
async function serving(root) {
  const child = startCli(root);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exit = new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  const origin = await new Promise((done, fail) => {
    const giveUp = setTimeout(() => fail(new Error(`server did not start:\n${stderr}`)), 15_000);
    child.stdout.on("data", () => {
      const match = stdout.match(/Local: (http:\/\/127\.0\.0\.1:\d+)\//);
      if (match === null) return;
      clearTimeout(giveUp);
      done(match[1]);
    });
    child.once("exit", () => {
      clearTimeout(giveUp);
      fail(new Error(`server exited before readiness:\n${stderr}`));
    });
  });

  return {
    origin,
    said: () => stderr,
    async get(path = "/") {
      const response = await fetch(`${origin}${path}`);
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        body: await response.text(),
      };
    },
    async bytes(path = "/") {
      const response = await fetch(`${origin}${path}`);
      return Buffer.from(await response.arrayBuffer());
    },
    async stop() {
      child.kill("SIGTERM");
      return await exit;
    },
    async abandon() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit.catch(() => undefined);
    },
  };
}

/** A configuration this server refuses: it says one thing, and it never reaches readiness. */
async function refusal(root) {
  const child = startCli(root);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const result = await new Promise((done, fail) => {
    const giveUp = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`the CLI did not exit:\n${stderr}`));
    }, 15_000);
    child.once("exit", (code) => {
      clearTimeout(giveUp);
      done({ code, stdout, stderr });
    });
  });
  return result;
}

describe("one bounded transformIndexHtml pre hook", () => {
  test.each([["esm"], ["commonjs"]])(
    "%s: the hook is given the project's own document and its replacement is served",
    async (module) => {
      const root = await createFixture({
        "package.json": module === "esm" ? '{"type":"module"}\n' : '{"type":"commonjs"}\n',
        "vite.config.js": configurationDeclaring(
          `(html, context) => {
            if (html.includes("@rsvite/client")) throw new Error("the built-in client reached the hook");
            return "<html><body data-path=\\"" + context.path + "\\">" + html + "</body></html>";
          }`,
          { module: module === "esm" ? "esm" : "commonjs" },
        ),
      });
      const server = await serving(root);

      try {
        const response = await server.get();
        expect(response.status).toBe(200);
        expect(response.type).toBe("text/html; charset=utf-8");
        // The hook wrapped the fragment, and the built-in client was added after it ran.
        expect(response.body).toContain(
          '<html><body data-path="/index.html"><div id="app">fragment</div></body></html>',
        );
        expect(response.body).toContain('<script type="module" src="/@rsvite/client"></script>');

        // The project's own file is untouched by serving it.
        await expect(readFile(join(root, "index.html"), "utf8")).resolves.toBe(
          '<div id="app">fragment</div>',
        );
        await expect(server.stop()).resolves.toEqual({ code: 0, signal: null });
      } finally {
        await server.abandon();
      }
    },
  );

  test("the hook is told the file the request resolves to", async () => {
    const root = await createFixture({
      "vite.config.js": configurationDeclaring("(html, context) => context.filename"),
    });
    const server = await serving(root);

    try {
      const response = await server.get();
      expect(response.body).toContain(resolve(root, "index.html"));
      await server.stop();
    } finally {
      await server.abandon();
    }
  });

  test("an empty plugin list serves the document as the project wrote it", async () => {
    const root = await createFixture({
      "vite.config.js": "export default { server: { port: 0 }, plugins: [] };\n",
    });
    const server = await serving(root);

    try {
      const response = await server.get();
      expect(response.status).toBe(200);
      expect(response.body).toBe(
        '<div id="app">fragment</div>\n<script type="module" src="/@rsvite/client"></script>\n',
      );
      await server.stop();
    } finally {
      await server.abandon();
    }
  });

  test("a project with no hook is answered with its own bytes", async () => {
    const root = await createFixture({
      "vite.config.js": "export default { server: { port: 0 } };\n",
    });
    // Bytes no reader could take as text: without a hook nothing reads this document as text.
    await writeFile(join(root, "index.html"), Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]));
    const server = await serving(root);

    try {
      const bytes = await server.bytes();
      expect([...bytes.subarray(0, 5)]).toEqual([0x3c, 0x70, 0x3e, 0xff, 0xfe]);
      await server.stop();
    } finally {
      await server.abandon();
    }
  });

  test("a document a hook cannot be given is one controlled failure", async () => {
    const root = await createFixture({
      "vite.config.js": configurationDeclaring("(html) => html"),
    });
    await writeFile(join(root, "index.html"), Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]));
    const server = await serving(root);

    try {
      const response = await server.get();
      expect(response.status).toBe(500);
      expect(response.body).toContain("index.html is not valid UTF-8");
      await expect(server.stop()).resolves.toEqual({ code: 0, signal: null });
    } finally {
      await server.abandon();
    }
  });

  test.each([
    ["undefined", "() => undefined"],
    ["an empty string", '() => ""'],
  ])("%s leaves the document as it was", async (_name, handler) => {
    const root = await createFixture({ "vite.config.js": configurationDeclaring(handler) });
    const server = await serving(root);

    try {
      const response = await server.get();
      expect(response.status).toBe(200);
      expect(response.body).toBe(
        '<div id="app">fragment</div>\n<script type="module" src="/@rsvite/client"></script>\n',
      );
      await server.stop();
    } finally {
      await server.abandon();
    }
  });

  test.each([
    [
      "a hook that throws",
      "() => { throw new Error('hook detail'); }",
      "rsvite: plugin wrap failed to transform index.html: hook detail\n",
    ],
    [
      "a hook that throws a value with no text",
      "() => { throw Object.create(null); }",
      "rsvite: plugin wrap failed to transform index.html: error value cannot be converted to text\n",
    ],
    [
      "a hook that throws a rejected Promise",
      "() => { throw Promise.reject(new Error('thrown-rejection')); }",
      "rsvite: plugin wrap failed to transform index.html: [object Promise]\n",
    ],
    [
      "a hook that answers with a fulfilled Promise",
      'async () => "<p>later</p>"',
      "rsvite: plugin wrap must return a string or undefined\n",
    ],
    [
      "a hook that answers with a rejected Promise",
      "() => Promise.reject(new Error('rejected'))",
      "rsvite: plugin wrap must return a string or undefined\n",
    ],
    [
      "a hook that answers with tag descriptors",
      "() => [{ tag: 'script' }]",
      "rsvite: plugin wrap must return a string or undefined\n",
    ],
    [
      "a hook that answers with null",
      "() => null",
      "rsvite: plugin wrap must return a string or undefined\n",
    ],
    [
      "a hook that answers with a number",
      "() => 1",
      "rsvite: plugin wrap must return a string or undefined\n",
    ],
  ])("%s fails that request and no more", async (_name, handler, expected) => {
    const root = await createFixture({ "vite.config.js": configurationDeclaring(handler) });
    const server = await serving(root);

    try {
      const response = await server.get();
      expect(response.status).toBe(500);
      expect(response.type).toBe("text/plain; charset=utf-8");
      // The whole reply, so a document is never served alongside the refusal to transform it.
      expect(response.body).toBe(expected);

      // The server answers the next request, and nothing was left unhandled behind this one.
      await expect(server.get("/@rsvite/client")).resolves.toMatchObject({ status: 200 });
      expect(server.said()).toBe("");
      await expect(server.stop()).resolves.toEqual({ code: 0, signal: null });
    } finally {
      await server.abandon();
    }
  });

  /**
   * A failed root request costs that request and nothing more.
   *
   * Only the root goes through the hook, so both requests here are for the root: one that the
   * hook fails, and one that it answers with a document.
   */
  test("the same hook can fail one root request and transform the next", async () => {
    const root = await createFixture({
      "vite.config.js": configurationDeclaring(
        `(html) => { globalThis.__failed = globalThis.__failed ?? false; if (!globalThis.__failed) { globalThis.__failed = true; throw new Error("first attempt"); } return "<main>" + html + "</main>"; }`,
      ),
    });
    const server = await serving(root);

    try {
      const failed = await server.get();
      expect(failed.status).toBe(500);
      expect(failed.body).toBe(
        "rsvite: plugin wrap failed to transform index.html: first attempt\n",
      );

      const recovered = await server.get();
      expect(recovered.status).toBe(200);
      expect(recovered.body).toContain('<main><div id="app">fragment</div></main>');
      expect(server.said()).toBe("");
      await expect(server.stop()).resolves.toEqual({ code: 0, signal: null });
    } finally {
      await server.abandon();
    }
  });

  /**
   * A value that refuses to give a message may still have a text form.
   *
   * The message is asked for first and separately; a value that throws when asked is then
   * asked what it converts to, and only a value that answers neither is reported by the fixed
   * description.
   */
  test("a thrown value that refuses a message is reported by its text form", async () => {
    const root = await createFixture({
      "vite.config.js": [
        'const refused = { toString: () => "converted" };',
        'Object.defineProperty(refused, "message", { get() { throw new Error("no message"); } });',
        'export default { server: { port: 0 }, plugins: [ { name: "wrap", transformIndexHtml: { order: "pre", handler: () => { throw refused; } } } ] };',
        "",
      ].join("\n"),
    });
    const server = await serving(root);

    try {
      const response = await server.get();
      expect(response.status).toBe(500);
      expect(response.body).toBe("rsvite: plugin wrap failed to transform index.html: converted\n");
      await expect(server.stop()).resolves.toEqual({ code: 0, signal: null });
    } finally {
      await server.abandon();
    }
  });

  test("each request reads the file again and runs the hook again", async () => {
    const root = await createFixture({
      "vite.config.js": configurationDeclaring(
        `(html) => { globalThis.__calls = (globalThis.__calls ?? 0) + 1; return "<main data-call=\\"" + globalThis.__calls + "\\">" + html + "</main>"; }`,
      ),
    });
    const server = await serving(root);

    try {
      const first = await server.get();
      expect(first.body).toContain('<main data-call="1"><div id="app">fragment</div></main>');

      await writeFile(join(root, "index.html"), '<div id="app">edited</div>');
      const second = await server.get();
      // The second reply is the new source through the hook, not the first reply kept.
      expect(second.body).toContain('<main data-call="2"><div id="app">edited</div></main>');
      await server.stop();
    } finally {
      await server.abandon();
    }
  });

  test("what one request's hook does to its context does not reach the next", async () => {
    const root = await createFixture({
      "vite.config.js": configurationDeclaring(
        `(html, context) => { const seen = context.path + " " + context.filename; context.path = "/mutated"; context.filename = "/mutated"; return "<seen>" + seen + "</seen>"; }`,
      ),
    });
    const server = await serving(root);

    try {
      const expected = `<seen>/index.html ${resolve(root, "index.html")}</seen>`;
      // The first hook is given the root document's own names and changes both of them.
      await expect(server.get()).resolves.toMatchObject({ status: 200 });
      const second = await server.get();
      // The second request is given those same names, not what the first left behind.
      expect(second.body).toContain(expected);
      await server.stop();
    } finally {
      await server.abandon();
    }
  });

  test.each([
    [
      "a list whose entry is read rather than held",
      `const list = []; Object.defineProperty(list, "0", { get: () => ({ name: "wrap", transformIndexHtml: { order: "pre", handler: (h) => h } }), enumerable: true, configurable: true }); Object.defineProperty(list, "length", { value: 1 });`,
      "configuration.plugins.0 must be a data property",
    ],
    [
      "a list carrying a key no request could name",
      `const list = [ { name: "wrap", transformIndexHtml: { order: "pre", handler: (h) => h } } ]; list[Symbol("secret")] = 1;`,
      "configuration.plugins has unsupported key Symbol(secret)",
    ],
    [
      "a list carrying a key beyond its entries",
      `const list = [ { name: "wrap", transformIndexHtml: { order: "pre", handler: (h) => h } } ]; list.extra = 1;`,
      "configuration.plugins has unsupported key extra",
    ],
  ])("refuses %s rather than resolving it", async (_name, preamble, message) => {
    const root = await createFixture({
      "vite.config.js": `${preamble}\nexport default { server: { port: 0 }, plugins: list };\n`,
    });

    const result = await refusal(root);

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("Local:");
    expect(result.stderr).toBe(`rsvite: invalid vite.config.js: ${message}\n`);
  });

  test.each([
    [
      "more than one plugin",
      '[ { name: "a", transformIndexHtml: { order: "pre", handler: (h) => h } }, { name: "b", transformIndexHtml: { order: "pre", handler: (h) => h } } ]',
      "configuration.plugins accepts at most one plugin",
    ],
    [
      "a nested list",
      '[ [ { name: "a", transformIndexHtml: { order: "pre", handler: (h) => h } } ] ]',
      "configuration.plugins[0] must be a plain object",
    ],
    ["a placeholder entry", "[ null ]", "configuration.plugins[0] must be a plain object"],
    ["a list that is not one", '{ name: "a" }', "configuration.plugins must be an array"],
    [
      "a missing name",
      '[ { transformIndexHtml: { order: "pre", handler: (h) => h } } ]',
      "configuration.plugins[0].name must be a non-empty string",
    ],
    [
      "an empty name",
      '[ { name: "", transformIndexHtml: { order: "pre", handler: (h) => h } } ]',
      "configuration.plugins[0].name must be a non-empty string",
    ],
    [
      "a field this level does not support",
      '[ { name: "a", enforce: "pre", transformIndexHtml: { order: "pre", handler: (h) => h } } ]',
      "configuration.plugins[0] has unsupported key enforce",
    ],
    [
      "a name that is read rather than held",
      '[ Object.defineProperty({ transformIndexHtml: { order: "pre", handler: (h) => h } }, "name", { get: () => "a", enumerable: true, configurable: true }) ]',
      "configuration.plugins[0].name must be a data property",
    ],
    [
      "the function form of the hook",
      '[ { name: "a", transformIndexHtml: (h) => h } ]',
      "configuration.plugins[0].transformIndexHtml must be an object with order and handler",
    ],
    [
      "a hook field this level does not support",
      '[ { name: "a", transformIndexHtml: { order: "pre", handler: (h) => h, enforce: 1 } } ]',
      "configuration.plugins[0].transformIndexHtml has unsupported key enforce",
    ],
    [
      "an order this level does not run",
      '[ { name: "a", transformIndexHtml: { order: "post", handler: (h) => h } } ]',
      'configuration.plugins[0].transformIndexHtml.order must be "pre"',
    ],
    [
      "no order at all",
      '[ { name: "a", transformIndexHtml: { handler: (h) => h } } ]',
      'configuration.plugins[0].transformIndexHtml.order must be "pre"',
    ],
    [
      "a handler that is not a function",
      '[ { name: "a", transformIndexHtml: { order: "pre", handler: "wrap" } } ]',
      "configuration.plugins[0].transformIndexHtml.handler must be a function",
    ],
  ])("refuses %s rather than ignoring it", async (_name, plugins, message) => {
    const root = await createFixture({
      "vite.config.js": `export default { server: { port: 0 }, plugins: ${plugins} };\n`,
    });

    const result = await refusal(root);

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("Local:");
    expect(result.stderr).toBe(`rsvite: invalid vite.config.js: ${message}\n`);
  });

  test("refuses a plugin carrying a key no request could name", async () => {
    const root = await createFixture({
      "vite.config.js": [
        'const plugin = { name: "a", transformIndexHtml: { order: "pre", handler: (h) => h } };',
        'plugin[Symbol("secret")] = 1;',
        "export default { server: { port: 0 }, plugins: [plugin] };",
        "",
      ].join("\n"),
    });

    const result = await refusal(root);

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("Local:");
    expect(result.stderr).toContain("configuration.plugins[0] has unsupported key Symbol(secret)");
  });
});
