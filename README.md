# rsvite

rsvite is a Rust implementation of Vite for existing Vite projects. Users start it through Node.js and npm; Node enters the Rust core through `napi-rs`, while JavaScript is available for configuration, plugins, and runtime behavior that must execute in JavaScript.

The first development path serves a root `index.html` and its local JavaScript or basic TypeScript modules directly from Rust. It establishes the Node CLI → `napi-rs` → Rust boundary, Rust-owned import analysis, transformation, graph state, and native server lifecycle. Its C1 configuration behavior lets Node select a validated static `server.port` before entering the same private N-API start object. Rust owns the listener and lifecycle; the CLI does not invoke Vite's development server, config bundler, or Plugin API as a fallback.

## Try the HTML, JavaScript, and TypeScript slice

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run build:rsvite:native
corepack pnpm exec rsvite fixtures/m1-basic-html --port 5173
# Or: corepack pnpm exec rsvite fixtures/m1-basic-typescript --port 5173
```

The third fixture, `fixtures/m1-basic-css-assets`, links a stylesheet that references an SVG with a relative URL; editing either file reloads the open page and shows the change without a restart.

Open <http://127.0.0.1:5173/>. The JavaScript fixture's `main.js` imports `./message` without an extension; Rust resolves it to `message.js`, rewrites the browser URL, and retains the importer/importee edge. The TypeScript fixture exercises the same path with `main.ts` and an extensionless `message.ts`; Rust removes their variable type annotations before responding. The server watches the project and reads and transforms modules on every request, so saving the imported dependency reloads the open page and shows the new value. `Ctrl+C` closes the Rust listener before the command exits.

This slice accepts one positional root and `--port`. It serves `GET /`, project-contained `.js` and `.ts` module requests, project-contained `.css` and `.svg` resource requests, and the built-in reload client and event stream. A successful root response carries the project's own HTML followed by a `/@rsvite/client` module reference; an edit to a file this server serves sends one reload event to every open stream once that edit window falls quiet, and a page ignores further events while it is already loading the next document, so a burst during one navigation is one load. Modules support relative and root-relative local imports and try `.js` before `.ts` for an extensionless import. A `.ts` response removes type annotations on variable declarations; retained TypeScript class syntax or a different TypeScript/JavaScript program shape fails the request before any module bytes are returned. A stylesheet is returned as `text/css; charset=utf-8` and an SVG as `image/svg+xml`, both `Cache-Control: no-store` and both re-read on every request; the browser resolves a stylesheet's own relative URLs, and rsvite neither parses nor rewrites CSS. A stylesheet or asset request is recognised by reading its path as text, so an encoded extension such as `styles%2Ecss` names the stylesheet it spells. The file itself comes from one strict decoding of that request, which is the only decoded value used to resolve it, so a malformed escape such as `%ZZ` is a `400` rather than a request for a file named after the mistake. A path whose raw suffix is `.js` or `.ts` enters the module route and decodes under the module rules. A request for any other extension is an empty `404` rather than a static-file fallback. TSX/JSX, source maps, bare packages, CSS `@import`, CSS modules, preprocessors, other asset types, configuration beyond the static C1 port subset below, plugins, state-preserving HMR, build, preview, and programmatic APIs are unsupported.

## Static `server.port` configuration

At startup, rsvite searches the project root in Vite's default filename order: `vite.config.js`, `vite.config.mjs`, `vite.config.ts`, `vite.config.cjs`, `vite.config.mts`, then `vite.config.cts`. When no file is found, rsvite uses the no-config behavior. The C1 subset supports only the first filename: if another candidate is the first one found, startup fails once and names that unsupported file; the explicit `--config` option is unsupported.

rsvite evaluates `vite.config.js` once through Node's native module loader. It accepts an ESM default export or CommonJS `module.exports` only when it is a plain object containing at most `server`, whose value is a plain object containing at most an integer `port` from 0 through 65535. Functions, Promises, arrays, other export values, unknown keys, and invalid ports fail before Rust starts. After module evaluation returns, an exported native Promise fails without waiting for settlement. The CLI first observes that export through the intrinsic Promise API. If Promise species prevents attachment, a temporary identity-filtered listener observes the export and rethrows an unrelated rejection on Node's normal error path. An explicit `--port` discovers, evaluates, and validates the file, then wins over `server.port`; without it, the configured port wins over the 5173 default. A selected port is exact, including `0` for an ephemeral port: a busy nonzero port reports Rust's typed bind failure rather than scanning upward. A running process does not watch or reload configuration. Configuration functions or Promises, other default filenames, explicit paths, modes, environment loading, aliases, host or strict-port settings, plugins, JavaScript callbacks over N-API, configuration watching, build, preview, and programmatic APIs are not part of this C1 subset.

Run its focused acceptance with:

```sh
corepack pnpm exec vp run test:m1:html
```

The fixtures are the positive product checks. The focused acceptance also validates a pinned upstream comparison. The pinned upstream case requires C2 `transformIndexHtml`. The binding-level replay starts the private `DevServer` directly, so it is C0 negative evidence. A public C1 CLI run at the same root imports `vite.config.js` and rejects its unsupported `input` key before Rust starts without invoking the Plugin API.

Compatibility is measured against pinned Vite upstream E2E tests and pinned real projects. The pinned corpus establishes that evidence, and this slice implements the first Node-started Rust development path.

See the [Project Context Records](.agents/docs/README.md) for the product intent, architecture boundaries, compatibility rules, and current roadmap.
