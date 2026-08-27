// A Playwright stand-in that behaves like an application arriving: the page redirects itself as
// soon as the navigation settles, and then stays put. It is resolved through the same
// `node_modules/playwright` lookup the adapter performs against a checkout, so the adapter runs
// exactly as it does in a real run.
//
// The redirect is scheduled on the next macrotask rather than after a chosen delay. That is what
// makes the test independent of scheduling luck: it is ordered strictly after `goto` resolves,
// which is the only ordering the behaviour under test depends on.
"use strict";

function createPage() {
  const handlers = new Map();
  let path = "/";

  const frame = { url: () => `http://localhost:3001${path}` };
  const page = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    async goto() {
      setTimeout(() => page.navigate("/bootstrap"), 0);
      return undefined;
    },
    /** Moves the main frame and reports it, exactly as a real navigation would. */
    navigate(to) {
      path = to;
      handlers.get("framenavigated")?.(frame);
    },
    evaluate: async () => undefined,
    mainFrame: () => frame,
    url: () => frame.url(),
  };
  return page;
}

let lastPage;

exports.chromium = {
  async launch() {
    const page = createPage();
    lastPage = page;
    return {
      async newContext() {
        return {
          addInitScript: async () => undefined,
          newPage: async () => page,
        };
      },
      close: async () => undefined,
    };
  },
};

exports.__lastPage = () => lastPage;
