import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { DevServer } from "../native.js";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "rsvite-binding-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "index.html"), "<h1>binding</h1>");
  return root;
}

describe("private native binding", () => {
  test("starts after binding and exposes the actual loopback address", async () => {
    const server = await DevServer.start({ root: await temporaryRoot(), port: 0 });

    try {
      expect(server.address).toMatch(/^127\.0\.0\.1:\d+$/);
      // The document the project wrote, followed by the built-in client that opens the stream.
      expect(await fetch(`http://${server.address}/`).then((response) => response.text())).toBe(
        `<h1>binding</h1>\n<script type="module" src="/@rsvite/client"></script>\n`,
      );
    } finally {
      await server.close();
    }
    await expect(server.wait()).resolves.toBeUndefined();
  });

  test("rejects a missing root", async () => {
    const root = join(await temporaryRoot(), "missing");
    await expect(DevServer.start({ root, port: 0 })).rejects.toThrow("failed to resolve root");
  });

  test("rejects a busy requested port", async () => {
    const occupied = createServer();
    await new Promise((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP address");

    try {
      await expect(
        DevServer.start({ root: await temporaryRoot(), port: address.port }),
      ).rejects.toThrow(`failed to bind 127.0.0.1:${String(address.port)}`);
    } finally {
      await new Promise((resolve, reject) => {
        occupied.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  /**
   * Runs one probe in a process of its own and requires that process to end by itself.
   *
   * A server this binding started keeps its process alive while it holds anything of the caller's,
   * so "the process ended" is the observation these proofs rest on, and it cannot be made from
   * inside the long-lived runner. The deadline is shorter than the surrounding budget so a process
   * that never ends is reported as that, and a process that outlives the proof is this test's to
   * end however the proof came out.
   */
  async function inAProcessOfItsOwn(source, { root, exposeCollection = false }) {
    const child = spawn(
      process.execPath,
      [...(exposeCollection ? ["--expose-gc"] : []), "--input-type=module", "-e", source],
      {
        env: { ...process.env, RSVITE_PROBE_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let printed = "";
    let errors = "";
    child.stdout.on("data", (chunk) => {
      printed += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });

    try {
      const ended = await new Promise((done, fail) => {
        child.once("error", fail);
        child.once("exit", (code) => done({ code }));
        setTimeout(() => done({ code: "did not exit" }), 10_000);
      });
      return { ...ended, errors, printed };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }

  const nativeUrl = new URL("../native.js", import.meta.url).href;

  /**
   * The wrapper is the only thing holding this server.
   *
   * A program that lets go of it without calling `close()` — which is what a garbage collector
   * does on its behalf — must not leave a listener, a watcher and their tasks running with nobody
   * able to reach them. A server holding a transformation must not either: the callback is the
   * caller's, and keeping it is what would leave the process unable to end.
   */
  test.each([
    ["without a transformation", "undefined", false],
    [
      "holding a transformation",
      '(html) => { if (typeof html !== "string") handedOnlyText = false; return "<main>" + html + "</main>"; }',
      true,
    ],
  ])(
    "collecting the last handle %s closes the server and frees its port",
    async (_name, transform, transformed) => {
      const root = await temporaryRoot();
      const result = await inAProcessOfItsOwn(
        `
import { createServer } from "node:net";
import { DevServer } from "${nativeUrl}";

const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

let collected = false;
const registry = new FinalizationRegistry(() => {
  collected = true;
});
let handedOnlyText = true;

// The wrapper is made and let go inside this call, so nothing out here refers to it afterwards.
// A transformation that reached back to the wrapper would keep it alive and there would be
// nothing to collect, so this one does not.
async function startAndLetGo() {
  const server = await DevServer.start({
    root: process.env.RSVITE_PROBE_ROOT,
    port: 0,
    transformIndexHtml: ${transform},
  });
  registry.register(server, "server");
  return server.address;
}

const address = await startAndLetGo();
const served = await fetch("http://" + address + "/").then((response) => response.text());

for (let attempt = 0; attempt < 200 && !collected; attempt += 1) {
  global.gc();
  await wait(20);
}

let reachable = true;
for (let attempt = 0; attempt < 250 && reachable; attempt += 1) {
  try {
    await fetch("http://" + address + "/");
    await wait(20);
  } catch {
    reachable = false;
  }
}

const port = Number(address.split(":")[1]);
const rebound = await new Promise((done) => {
  const listener = createServer();
  listener.once("error", () => done(false));
  listener.listen(port, "127.0.0.1", () => listener.close(() => done(true)));
});

console.log(
  JSON.stringify({
    transformed: served.includes("<main><h1>binding</h1></main>"),
    handedOnlyText,
    collected,
    reachable,
    rebound,
  }),
);
`,
        { root, exposeCollection: true },
      );

      expect({ code: result.code, errors: result.errors }).toEqual({ code: 0, errors: "" });
      expect(JSON.parse(result.printed)).toEqual({
        transformed,
        handedOnlyText: true,
        collected: true,
        reachable: false,
        rebound: true,
      });
    },
  );

  /**
   * Closing releases the transformation exactly as collection does.
   *
   * A closed listener, a quiet address and a free port do not show it: a server can report all
   * three while holding the caller's callback, which leaves the process unable to end. The wrapper
   * here stays reachable for the whole probe, and the process has to end anyway.
   */
  test("closing a plugin-enabled server releases its callback, its port and the process", async () => {
    const root = await temporaryRoot();
    const result = await inAProcessOfItsOwn(
      `
import { createServer } from "node:net";
import { DevServer } from "${nativeUrl}";

const handed = [];
// Held for the whole probe, so nothing here is released by going out of reach.
const server = await DevServer.start({
  root: process.env.RSVITE_PROBE_ROOT,
  port: 0,
  transformIndexHtml: (html) => {
    handed.push(typeof html);
    return "<main>" + html + "</main>";
  },
});
const address = server.address;
const served = await fetch("http://" + address + "/").then((response) => response.text());

await server.close();
await server.wait();

let reachable = true;
try {
  await fetch("http://" + address + "/");
} catch {
  reachable = false;
}

const port = Number(address.split(":")[1]);
const rebound = await new Promise((done) => {
  const listener = createServer();
  listener.once("error", () => done(false));
  listener.listen(port, "127.0.0.1", () => listener.close(() => done(true)));
});

console.log(
  JSON.stringify({
    handed,
    transformed: served.includes("<main><h1>binding</h1></main>"),
    stillReferenced: typeof server.address === "string",
    reachable,
    rebound,
  }),
);
`,
      { root },
    );

    expect({ code: result.code, errors: result.errors }).toEqual({ code: 0, errors: "" });
    // Only the document text crossed the boundary, and only its replacement came back.
    expect(JSON.parse(result.printed)).toEqual({
      handed: ["string"],
      transformed: true,
      stillReferenced: true,
      reachable: false,
      rebound: true,
    });
  });
});
