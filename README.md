# rsvite

rsvite is a Rust implementation of Vite for existing Vite projects. Users start it through Node.js and npm; Node enters the Rust core through `napi-rs`, while JavaScript remains available for the configuration, plugins, and runtime behavior that must execute in JavaScript.

The first development path serves a root `index.html` and its local JavaScript modules directly from Rust. It establishes the Node CLI → `napi-rs` → Rust boundary, Rust-owned import analysis and graph state, and the native server lifecycle without loading Vite configuration, plugins, or Vite core as a fallback.

## Try the HTML and JavaScript slice

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run build:rsvite:native
corepack pnpm exec rsvite fixtures/m1-basic-html --port 5173
```

Open <http://127.0.0.1:5173/>. The fixture's `main.js` imports `./message` without an extension; Rust resolves it to `message.js`, rewrites the browser URL, and retains the importer/importee edge. The server reads and analyzes both modules on every request, so editing `src/message.js` and reloading the page shows the new value. `Ctrl+C` closes the Rust listener before the command exits.

This slice accepts one positional root and `--port`. It serves `GET /` plus project-contained `.js` module requests, supports relative and root-relative local imports, and adds no JavaScript fallback. TypeScript, bare packages, CSS, assets, configuration, plugins, file watching, automatic reload, HMR, build, preview, and programmatic APIs remain unsupported.

Run its focused acceptance with:

```sh
corepack pnpm exec vp run test:m1:html
```

The fixture is the positive product check. The task also validates a pinned upstream comparison: Vite passes after the project's C2 `transformIndexHtml` hook, while this C0 rsvite slice ignores configuration and Plugin API and records the unchanged upstream assertion as expected negative evidence.

Compatibility is measured against pinned Vite upstream E2E tests and pinned real projects. The pinned corpus establishes that evidence, and this slice implements the first Node-started Rust development path.

See the [Project Context Records](.agents/docs/README.md) for the product intent, architecture boundaries, compatibility rules, and current roadmap.
