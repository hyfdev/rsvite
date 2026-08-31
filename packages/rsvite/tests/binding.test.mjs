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
   * The wrapper is the only thing holding this server.
   *
   * A program that lets go of it without calling `close()` — which is what a garbage collector
   * does on its behalf — must not leave a listener, a watcher and their tasks running with nobody
   * able to reach them. Collection is what has to be observed, so this runs in a child that can be
   * given `--expose-gc` and reports what it saw after the wrapper was collected.
   */
  test("collecting the last handle closes the server and frees its port", async () => {
    const root = await temporaryRoot();
    const probe = `
import { createServer } from "node:net";
import { DevServer } from "${new URL("../native.js", import.meta.url).href}";

const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

let collected = false;
const registry = new FinalizationRegistry(() => {
  collected = true;
});

// The wrapper is made and let go inside this call, so nothing out here refers to it afterwards.
async function startAndLetGo() {
  const server = await DevServer.start({ root: process.env.RSVITE_PROBE_ROOT, port: 0 });
  registry.register(server, "server");
  return server.address;
}

const address = await startAndLetGo();
const served = await fetch("http://" + address + "/").then((response) => response.status);

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

console.log(JSON.stringify({ served, collected, reachable, rebound }));
`;

    const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", probe], {
      env: { ...process.env, RSVITE_PROBE_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let printed = "";
    let errors = "";
    child.stdout.on("data", (chunk) => {
      printed += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    const code = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("exit", done);
    });

    expect({ code, errors }).toEqual({ code: 0, errors: "" });
    expect(JSON.parse(printed)).toEqual({
      served: 200,
      collected: true,
      reachable: false,
      rebound: true,
    });
  });
});
