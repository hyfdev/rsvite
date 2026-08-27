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
      expect(await fetch(`http://${server.address}/`).then((response) => response.text())).toBe(
        "<h1>binding</h1>",
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
});
