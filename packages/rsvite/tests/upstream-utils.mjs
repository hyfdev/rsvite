// oxlint-disable-next-line vite-plus/prefer-vite-plus-imports -- the paired run must use the external Vite lockfile's Vitest instance
import { afterAll, beforeAll } from "vitest";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DevServer } from "../native.js";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../..");
const upstreamRoot =
  process.env["RSVITE_UPSTREAM_ROOT"] ??
  resolve(repositoryRoot, "corpus/vite-upstream/playground/html");

let browser;
let server;

const importedPlaywright = process.env["RSVITE_PLAYWRIGHT_MODULE"]
  ? await import(pathToFileURL(process.env["RSVITE_PLAYWRIGHT_MODULE"]).href)
  : await import("playwright");
const playwright = importedPlaywright.chromium ? importedPlaywright : importedPlaywright.default;
const { chromium } = playwright;

export let page;
export let viteTestUrl = "";
export const browserLogs = [];
export const serverLogs = [];
export const isBuild = false;
export const isBundled = false;
export const isServe = true;
export const viteServer = undefined;

beforeAll(async () => {
  await access(resolve(upstreamRoot, "vite.config.js"));
  server = await DevServer.start({
    root: upstreamRoot,
    port: 0,
  });
  viteTestUrl = `http://${server.address}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.on("console", (message) => browserLogs.push(message.text()));
  page.on("pageerror", (error) => browserLogs.push(error.message));
  await page.goto(`${viteTestUrl}/`);
});

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.close();
  }
});

export async function editFile() {
  throw new Error("editFile is outside the selected upstream case");
}

export async function getColor(selector) {
  return page.$eval(selector, (element) => getComputedStyle(element).color);
}

export async function untilBrowserLogAfter() {
  throw new Error("untilBrowserLogAfter is outside the selected upstream case");
}
