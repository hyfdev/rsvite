import { appendFileSync } from "node:fs";

// A source fragment wrapped in a complete document before the page is asserted on, which is what
// the pinned upstream case needs. It stays inside what this compatibility level supports: one
// plugin, one object-form `transformIndexHtml` hook, ordered `pre`, answering synchronously.
//
// The record of what the hook was given is written only where a caller asks for it, so running
// this fixture directly leaves nothing behind in the project it demonstrates.
const record = process.env.RSVITE_FIXTURE_HOOK_LOG;

export default {
  plugins: [
    {
      name: "pre-transform",
      transformIndexHtml: {
        order: "pre",
        handler(html, context) {
          if (record !== undefined) {
            appendFileSync(
              record,
              `${context.path} ${context.filename} ${String(html.includes("@rsvite/client"))}\n`,
            );
          }
          return `<!doctype html><html><head><title>wrapped</title></head><body>${html}</body></html>`;
        },
      },
    },
  ],
};
