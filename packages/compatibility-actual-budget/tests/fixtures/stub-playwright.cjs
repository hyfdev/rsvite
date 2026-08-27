// A Playwright stand-in resolved through the same `node_modules/playwright` lookup the adapter
// performs against a checkout, so the adapter runs exactly as it does in a real run.
//
// Behaviour is driven by `stub-config.json` beside this file and observations are counted rather
// than timed, so every test states the sequence it wants instead of hoping the scheduler agrees.
"use strict";

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const configPath = join(__dirname, "stub-config.json");
const statePath = join(__dirname, "stub-state.json");

function config() {
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
}

function state() {
  return existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { launched: 0, closed: 0, contextStarted: 0 };
}

function record(patch) {
  writeFileSync(statePath, JSON.stringify({ ...state(), ...patch }));
}

function createPage(options) {
  const handlers = new Map();
  let path = "/";
  let observations = 0;
  const frame = { url: () => `http://localhost:3001${path}` };

  const page = {
    on: (event, handler) => handlers.set(event, handler),
    async goto() {
      // Ordered strictly after `goto` resolves, which is the only ordering the behaviour
      // under test depends on.
      if (options.redirectOnArrival !== false) setTimeout(() => page.navigate("/bootstrap"), 0);
      return undefined;
    },
    navigate(to) {
      path = to;
      handlers.get("framenavigated")?.(frame);
    },
    evaluate: async () => undefined,
    mainFrame: () => frame,
    url() {
      observations += 1;
      // A page that never finishes arriving moves on every single observation.
      if (options.neverSettles === true) path = `/moving-${String(observations)}`;
      return frame.url();
    },
  };
  return page;
}

let lastPage;

exports.__lastPage = () => lastPage;

exports.chromium = {
  async launch() {
    const options = config();
    if (options.launchDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.launchDelayMs));
    }
    record({ launched: state().launched + 1 });
    const page = createPage(options);
    lastPage = page;
    return {
      version: () => options.browserVersion ?? "149.0.0.0",
      async newContext() {
        record({ contextStarted: state().contextStarted + 1 });
        if (options.failAfterLaunch === true) {
          throw new Error("the browser context could not be created");
        }
        // A setup step that never settles: the operation a real driver leaves pending when the
        // browser stops answering. Nothing here rejects, so only an abort-aware caller escapes.
        if (options.hangIn === "newContext") return new Promise(() => {});
        return {
          addInitScript: async () =>
            options.hangIn === "addInitScript" ? new Promise(() => {}) : undefined,
          newPage: async () => (options.hangIn === "newPage" ? new Promise(() => {}) : page),
        };
      },
      async close() {
        record({ closed: state().closed + 1 });
      },
    };
  },
  executablePath: () => "/stub/chromium",
};
