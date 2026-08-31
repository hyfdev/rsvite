import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../..");
const rsviteBin = resolve(repositoryRoot, "node_modules/.bin/rsvite");

/**
 * How long a test waits before deciding an edit window produced nothing more.
 *
 * Every count is read after this, so "no further reload" is a waited-for fact rather than a race
 * the test happened to win.
 */
const SETTLED = 700;

const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/**
 * Proves the stream has sent exactly `expected` reloads and no more.
 *
 * How long an edit takes to reach the stream is not part of the contract, so this waits for the
 * count to arrive rather than reading it at a fixed moment; how many arrive is the contract, so it
 * then waits again and proves the count stopped there.
 */
async function sentReloads(server, expected) {
  const deadline = Date.now() + 15_000;
  while (server.reloads() < expected && Date.now() < deadline) await wait(50);
  await wait(SETTLED);
  // A server that stopped, and why, is the first thing worth knowing when an edit never arrives.
  expect(server.reloads(), server.account()).toBe(expected);
}

/**
 * A project served by the published `rsvite` command, with its reload stream open.
 *
 * These tests read the reload stream and the HTTP responses directly rather than through a
 * browser, because what has to be exact here is how many reloads one edit window produces and what
 * the server answers with afterwards.
 */
async function serving(prepare) {
  const root = await mkdtemp(join(tmpdir(), "rsvite-saves-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "index.html"), '<script type="module" src="/src/main.js"></script>');
  await writeFile(join(root, "src/main.js"), 'document.body.textContent = "initial";\n');
  await prepare?.({ root });

  const child = spawn(rsviteBin, [root, "--port", "0"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const exit = new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  const origin = await new Promise((done, fail) => {
    let printed = "";
    const giveUp = setTimeout(
      () => fail(new Error(`the server never printed an address: ${errors}`)),
      10_000,
    );
    child.stdout.on("data", (chunk) => {
      printed += String(chunk);
      const address = printed.match(/Local: (http:\/\/127\.0\.0\.1:\d+)\//);
      if (address === null) return;
      clearTimeout(giveUp);
      done(address[1]);
    });
  });

  const stream = await fetch(`${origin}/@rsvite/events`);
  expect(stream.status).toBe(200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const reading = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      received += decoder.decode(chunk.value, { stream: true });
    }
  })().catch(() => undefined);

  return {
    root,
    origin,
    reloads: () => [...received.matchAll(/event: full-reload/g)].length,
    pid: () => child.pid,
    async status(path) {
      return (await fetch(`${origin}${path}`)).status;
    },
    account: () =>
      `server ${
        child.exitCode === null && child.signalCode === null
          ? "still running"
          : `gone (code ${String(child.exitCode)}, signal ${String(child.signalCode)})`
      }${errors === "" ? "" : `, said: ${errors.trim()}`}`,
    async body(path) {
      return await (await fetch(`${origin}${path}`)).text();
    },
    async stop() {
      child.kill("SIGTERM");
      await expect(exit).resolves.toEqual({ code: 0, signal: null });
      await reading;
      await rm(root, { recursive: true, force: true });
    },
    async abandon() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("an ordinary edit reloads once, and the next edit is its own reload", async () => {
  const server = await serving();
  try {
    await writeFile(join(server.root, "src/main.js"), 'document.body.textContent = "first";\n');
    await sentReloads(server, 1);
    await expect(server.body("/src/main.js")).resolves.toContain("first");

    await writeFile(join(server.root, "src/main.js"), 'document.body.textContent = "second";\n');
    await sentReloads(server, 2);
    await expect(server.body("/src/main.js")).resolves.toContain("second");
    await server.stop();
  } finally {
    await server.abandon();
  }
});

test("edits made together share one reload", async () => {
  const server = await serving(async ({ root }) => {
    await writeFile(join(root, "src/styles.css"), "#app { color: red; }\n");
  });
  try {
    // Made together, so both land in one edit window. Waiting for the first write before starting
    // the second would leave a gap the window can outlive, which is a fact about this test's
    // timing rather than about what a shared window means.
    await Promise.all([
      writeFile(join(server.root, "src/main.js"), 'document.body.textContent = "both";\n'),
      writeFile(join(server.root, "src/styles.css"), "#app { color: blue; }\n"),
    ]);

    await sentReloads(server, 1);
    await expect(server.body("/src/main.js")).resolves.toContain("both");
    await expect(server.body("/src/styles.css")).resolves.toContain("blue");
    await server.stop();
  } finally {
    await server.abandon();
  }
});

test("a temporary written and closed before the rename reloads once", async () => {
  const server = await serving();
  const outside = await mkdtemp(join(tmpdir(), "rsvite-saves-outside-"));
  try {
    // Written and closed where the watcher never saw it, then renamed onto the served name.
    const pending = join(outside, "main.js.pending");
    await writeFile(pending, 'document.body.textContent = "replaced";\n');
    await rename(pending, join(server.root, "src/main.js"));

    await sentReloads(server, 1);
    await expect(server.body("/src/main.js")).resolves.toContain("replaced");
    await server.stop();
  } finally {
    await server.abandon();
    await rm(outside, { recursive: true, force: true });
  }
});

test("activity a page could never ask about reloads nothing", async () => {
  const server = await serving();
  const module = join(server.root, "src/main.js");
  let handle;
  try {
    // Opening a served file and letting go without changing it.
    handle = await open(module, "r+");
    await handle.close();
    handle = undefined;

    // Changing only its permissions.
    await chmod(module, 0o644);

    // Writing a file this server does not answer for.
    await writeFile(join(server.root, "notes.md"), "not served\n");

    // Renaming a directory that carries a served name, and removing a served file.
    await mkdir(join(server.root, "src/folder.js"));
    await rename(join(server.root, "src/folder.js"), join(server.root, "src/renamed.js"));
    await writeFile(join(server.root, "src/gone.css"), "#app { color: red; }\n");
    await sentReloads(server, 1);
    await rm(join(server.root, "src/gone.css"));

    await sentReloads(server, 1);

    // A real edit still reaches the stream.
    await writeFile(module, 'document.body.textContent = "edited";\n');
    await sentReloads(server, 2);
    await server.stop();
  } finally {
    await handle?.close().catch(() => undefined);
    await server.abandon();
  }
});

test("a document outside the project is watched where it actually lives", async () => {
  const outside = await mkdtemp(join(tmpdir(), "rsvite-saves-document-"));
  const first = join(outside, "first.html");
  const second = join(outside, "second.html");
  await writeFile(first, "<h1>first</h1>\n");
  await writeFile(second, "<h1>second</h1>\n");
  const server = await serving(async ({ root }) => {
    await rm(join(root, "index.html"));
    await symlink(first, join(root, "index.html"));
  });
  try {
    await expect(server.body("/")).resolves.toContain("first");
    expect(server.reloads()).toBe(0);

    // Writing the file the document comes from is an edit to the document.
    await writeFile(first, "<h1>first rewritten</h1>\n");
    await sentReloads(server, 1);
    await expect(server.body("/")).resolves.toContain("first rewritten");

    // Replacing it with a file written and closed beforehand is one edit too.
    const replacement = join(outside, "first.html.pending");
    await writeFile(replacement, "<h1>first replaced</h1>\n");
    await rename(replacement, first);
    await sentReloads(server, 2);
    await expect(server.body("/")).resolves.toContain("first replaced");

    // And so is pointing the document at another file outside the project.
    const pending = join(server.root, "index.html.pending");
    await symlink(second, pending);
    await rename(pending, join(server.root, "index.html"));
    await sentReloads(server, 3);
    await expect(server.body("/")).resolves.toContain("second");

    // The file it used to come from is not this server's business any more.
    await writeFile(first, "<h1>abandoned</h1>\n");
    await sentReloads(server, 3);
    await server.stop();
  } finally {
    await server.abandon();
    await rm(outside, { recursive: true, force: true });
  }
});

test("every link the root document goes through is watched, wherever it leads", async () => {
  const outside = await mkdtemp(join(tmpdir(), "rsvite-saves-chain-"));
  await mkdir(join(outside, "published"));
  await mkdir(join(outside, "drafts"));
  await writeFile(join(outside, "published/page.html"), "<h1>published</h1>\n");
  await writeFile(join(outside, "drafts/page.html"), "<h1>draft</h1>\n");
  await writeFile(join(outside, "other.html"), "<h1>other</h1>\n");
  await symlink("current/page.html", join(outside, "chosen.html"));
  await symlink("published", join(outside, "current"));
  const server = await serving(async ({ root }) => {
    await rm(join(root, "index.html"));
    await symlink(join(outside, "chosen.html"), join(root, "index.html"));
  });
  try {
    await expect(server.body("/")).resolves.toContain("published");
    expect(server.reloads()).toBe(0);

    // A directory link in the middle of the way decides which file is read.
    const directory = join(outside, "current.pending");
    await symlink("drafts", directory);
    await rename(directory, join(outside, "current"));
    await sentReloads(server, 1);
    await expect(server.body("/")).resolves.toContain("draft");

    // So does a file link in the middle of it.
    const link = join(outside, "chosen.pending");
    await symlink("other.html", link);
    await rename(link, join(outside, "chosen.html"));
    await sentReloads(server, 2);
    await expect(server.body("/")).resolves.toContain("other");

    // Where it used to lead is no longer watched.
    await writeFile(join(outside, "drafts/page.html"), "<h1>abandoned</h1>\n");
    await sentReloads(server, 2);

    // Where it leads now is.
    await writeFile(join(outside, "other.html"), "<h1>other rewritten</h1>\n");
    await sentReloads(server, 3);
    await expect(server.body("/")).resolves.toContain("other rewritten");
    await server.stop();
  } finally {
    await server.abandon();
    await rm(outside, { recursive: true, force: true });
  }
});

/** How many directories this server is watching, read from its own open inotify instances. */
async function watchedDirectories(pid) {
  const directory = `/proc/${String(pid)}/fdinfo`;
  const entries = await readdir(directory);
  let watched = 0;
  for (const entry of entries) {
    const info = await readFile(join(directory, entry), "utf8").catch(() => "");
    watched += info.split("\n").filter((line) => line.startsWith("inotify wd:")).length;
  }
  return watched;
}

test("a directory link out of the project is not followed into the tree behind it", async () => {
  const outside = await mkdtemp(join(tmpdir(), "rsvite-saves-tree-"));
  const buried = 24;
  for (let index = 0; index < buried; index += 1) {
    await mkdir(join(outside, `d${String(index)}`));
    await writeFile(join(outside, `d${String(index)}/file.js`), "export const buried = 1;\n");
  }

  // The same project twice: once plain, once with a link to that outside tree. The route answers
  // for nothing behind the link, so the link must not cost this server a watch out there.
  const control = await serving();
  const linked = await serving(async ({ root }) => {
    await symlink(outside, join(root, "external"));
  });
  try {
    await expect(linked.status("/external/d0/file.js")).resolves.toBe(403);
    expect(await watchedDirectories(linked.pid())).toBe(await watchedDirectories(control.pid()));

    // The project's own files are still watched.
    await writeFile(join(linked.root, "src/main.js"), 'document.body.textContent = "edited";\n');
    await sentReloads(linked, 1);
    await control.stop();
    await linked.stop();
  } finally {
    await control.abandon();
    await linked.abandon();
    await rm(outside, { recursive: true, force: true });
  }
});

test("an edit through a name the route answers for reloads, and a path it refuses does not", async () => {
  // `src/alias.js` is a name every segment of which a request may use. It leads to a file whose
  // own path no request could spell, so the route answers for the name while the filesystem
  // reports the edit under the path — the two are not the same name, and only one of them is
  // something a page can ask about.
  const server = await serving(async ({ root }) => {
    await mkdir(join(root, "bad\\dir"));
    await writeFile(join(root, "bad\\dir/actual.js"), 'export const actual = "first";\n');
    await symlink("../bad\\dir/actual.js", join(root, "src/alias.js"));
    await writeFile(join(root, "src/noise\\file.js"), 'export const noise = "first";\n');
  });
  try {
    await expect(server.status("/src/alias.js")).resolves.toBe(200);
    expect(await server.body("/src/alias.js")).toContain("first");

    // Asking for the file by its own path is a request this server refuses.
    await expect(server.status("/src/noise%5Cfile.js")).resolves.toBe(400);

    // Editing through the alias changes what that name is answered with, so the page is told.
    await writeFile(join(server.root, "src/alias.js"), 'export const actual = "second";\n');
    await sentReloads(server, 1);
    expect(await server.body("/src/alias.js")).toContain("second");

    // Editing a file no name leads to changes nothing any page could have.
    await writeFile(join(server.root, "src/noise\\file.js"), 'export const noise = "second";\n');
    await sentReloads(server, 1);

    // An ordinary edit still opens its own reload.
    await writeFile(join(server.root, "src/main.js"), 'document.body.textContent = "edited";\n');
    await sentReloads(server, 2);
    await server.stop();
  } finally {
    await server.abandon();
  }
});

/** A directory whose name is not text, so no request can spell a path that goes through it. */
const unnameable = (root) => Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff, 0xfe])]);

const inside = (directory, name) => Buffer.concat([directory, Buffer.from(name)]);

test("watching follows the route's own answer, both where it says yes and where it says no", async () => {
  // Three names a request may spell. One leaves the project and comes back, and the route answers
  // for it because containment is decided on the file it finally reaches. Two lead to a directory
  // whose name is not text: the module route can never write a URL for what it resolved to and
  // refuses permanently, while the stylesheet route returns the bytes it finds.
  let outside;
  const server = await serving(async ({ root }) => {
    outside = await mkdtemp(join(tmpdir(), "rsvite-saves-detour-"));
    await mkdir(join(root, "bad\\dir"));
    await writeFile(join(root, "bad\\dir/detour.js"), 'export const detour = "first";\n');
    await symlink(outside, join(root, "src/out"));
    await symlink(join(root, "bad\\dir"), join(outside, "back"));

    const weird = unnameable(root);
    await mkdir(weird);
    await writeFile(inside(weird, "/actual.js"), 'export const actual = "first";\n');
    await writeFile(inside(weird, "/actual.css"), "#app { color: red; }\n");
    await symlink(inside(weird, "/actual.js"), join(root, "src/alias.js"));
    await symlink(inside(weird, "/actual.css"), join(root, "src/alias.css"));
  });
  try {
    await expect(server.status("/src/out/back/detour.js")).resolves.toBe(200);
    await expect(server.status("/src/alias.js")).resolves.toBe(400);
    await expect(server.status("/src/alias.css")).resolves.toBe(200);

    // The route answers for the detour, so an edit to what it leads to reaches the page.
    await writeFile(join(server.root, "bad\\dir/detour.js"), 'export const detour = "second";\n');
    await sentReloads(server, 1);
    expect(await server.body("/src/out/back/detour.js")).toContain("second");

    // The module the route refuses permanently reloads nothing.
    const weird = unnameable(server.root);
    await writeFile(inside(weird, "/actual.js"), 'export const actual = "second";\n');
    await sentReloads(server, 1);

    // The stylesheet at the same shape of path is really served, so it does reload.
    await writeFile(inside(weird, "/actual.css"), "#app { color: blue; }\n");
    await sentReloads(server, 2);
    expect(await server.body("/src/alias.css")).toContain("blue");

    // An ordinary edit still opens its own reload.
    await writeFile(join(server.root, "src/main.js"), 'document.body.textContent = "edited";\n');
    await sentReloads(server, 3);
    await server.stop();
  } finally {
    await server.abandon();
    await rm(outside, { recursive: true, force: true });
  }
});
