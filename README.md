# rsvite

rsvite is a Rust implementation of Vite for existing Vite projects. Users start it through Node.js and npm; Node enters the Rust core through `napi-rs`, while JavaScript remains available for the configuration, plugins, and runtime behavior that must execute in JavaScript.

The first development path serves a root `index.html` and its local JavaScript or basic TypeScript modules directly from Rust. It establishes the Node CLI → `napi-rs` → Rust boundary, Rust-owned import analysis, transformation, and graph state, and the native server lifecycle without loading Vite configuration, plugins, or Vite core as a fallback.

## Try the HTML, JavaScript, and TypeScript slice

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run build:rsvite:native
corepack pnpm exec rsvite fixtures/m1-basic-html --port 5173
# Or: corepack pnpm exec rsvite fixtures/m1-basic-typescript --port 5173
```

The third fixture, `fixtures/m1-basic-css-assets`, links a stylesheet that references an SVG with a relative URL; editing either file and reloading shows the change without a restart.

Open <http://127.0.0.1:5173/>. The JavaScript fixture's `main.js` imports `./message` without an extension; Rust resolves it to `message.js`, rewrites the browser URL, and retains the importer/importee edge. The TypeScript fixture exercises the same path with `main.ts` and an extensionless `message.ts`; Rust removes their variable type annotations before responding. The server reads and transforms modules on every request, so editing the imported dependency and reloading the page shows the new value. `Ctrl+C` closes the Rust listener before the command exits.

This slice accepts one positional root and `--port`. It serves `GET /`, project-contained `.js` and `.ts` module requests, and project-contained `.css` and `.svg` resource requests. Modules support relative and root-relative local imports and try `.js` before `.ts` for an extensionless import. A `.ts` response removes type annotations on variable declarations; retained TypeScript class syntax or a different TypeScript/JavaScript program shape fails the request before any module bytes are returned. A stylesheet is returned as `text/css; charset=utf-8` and an SVG as `image/svg+xml`, both `Cache-Control: no-store` and both re-read on every request; the browser resolves a stylesheet's own relative URLs, and rsvite neither parses nor rewrites CSS. A stylesheet or asset request is recognised by reading its path as text, so an encoded extension such as `styles%2Ecss` names the stylesheet it spells. The file itself comes from one strict decoding of that request, which is the only decoded value used to resolve it, so a malformed escape such as `%ZZ` is a `400` rather than a request for a file named after the mistake. A path whose raw suffix is `.js` or `.ts` enters the module route and decodes under the module rules. A request for any other extension is an empty `404` rather than a static-file fallback. TSX/JSX, source maps, bare packages, CSS `@import`, CSS modules, preprocessors, other asset types, configuration, plugins, file watching, automatic reload, HMR, build, preview, and programmatic APIs remain unsupported.

Run its focused acceptance with:

```sh
corepack pnpm exec vp run test:m1:html
```

The fixtures are the positive product checks. The task also validates a pinned upstream comparison: Vite passes after the project's C2 `transformIndexHtml` hook, while this C0 rsvite slice ignores configuration and Plugin API and records the unchanged upstream assertion as expected negative evidence.

Compatibility is measured against pinned Vite upstream E2E tests and pinned real projects. The pinned corpus establishes that evidence, and this slice implements the first Node-started Rust development path.

See the [Project Context Records](.agents/docs/README.md) for the product intent, architecture boundaries, compatibility rules, and current roadmap.
