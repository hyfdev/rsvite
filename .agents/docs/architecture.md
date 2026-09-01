# Architecture

rsvite has a fixed product entry and execution-ownership rule. The first M1 slice below also fixes its Node/N-API/Rust process boundary and native server lifecycle; the local JavaScript and basic TypeScript slice fixes the first Rust-owned module request, transformation, and graph path. Watching maps each edit window to one coarse reload event and keeps no graph state of its own. The selected C2 `transformIndexHtml` pre hook runs in the CLI's own Node process and crosses to Rust as one string-to-string call. Placement for runtime JavaScript and for plugin hooks beyond that one, the callback protocol those later hooks need, the graph required for state-preserving HMR, and later capability internals remain open until implementation evidence selects them.
<!-- Author: rsvite-senior-engineer -->

## Fixed product boundary

- Every user-facing command starts in Node.js/npm and enters Rust through `napi-rs`, including projects with no Vite configuration or plugins.
  <!-- Author: rsvite-lead -->
- Rust owns dev and build execution, project state, the module graph, scheduling, built-in behavior, file watching, HTTP/HMR state, and the compatibility protocol.
  <!-- Author: rsvite-lead -->
- JavaScript executes only the user configuration, plugin hooks, runtime modules, or programmatic calls required by the [declared compatibility level](compatibility.md#javascript-api-levels). Node is not a second orchestration layer.
  <!-- Author: rsvite-lead -->
- Every implemented [product capability](compatibility.md#product-capability) records whether Rust or compatibility JavaScript owns it. An undeclared fallback to Vite's dev server, build orchestration, module graph, or scheduler cannot count as a Rust-first capability or a real-project pass.
  <!-- Author: rsvite-lead -->
- Rust units may be invoked directly by internal tests, but direct Rust invocation is not a user acceptance path.
  <!-- Author: rsvite-lead -->

## C1 `server.port` configuration boundary

At process startup, the Node CLI searches the selected root in the pinned Vite default order: `vite.config.js`, `vite.config.mjs`, `vite.config.ts`, `vite.config.cjs`, `vite.config.mts`, and `vite.config.cts`. No candidate found uses the C0 no-config path. Only a first-found `vite.config.js` is accepted in this C1 configuration subset; a first-found later filename produces one startup failure that names it, and explicit `--config` is rejected. Before importing the accepted file once with Node's native module loader, Node initializes a missing or empty `NODE_ENV` to `development` and preserves a nonempty parent value. A native static-import wrapper carries the actual namespace under a safe binding, so a callable module `then` cannot execute or replace the default export; it does not transform project source. The CLI does not invoke Vite's config bundler, development server, Plugin API, or a TypeScript transformer; the imported project configuration can use its own native Node dependencies, including Vite's `defineConfig`.
<!-- Author: rsvite-engineer -->

The accepted module default is resolved exactly once: a direct value, a Promise, or a synchronous or asynchronous function invoked with `{ command: "serve", mode: "development", isSsrBuild: false, isPreview: false }`. Its resolved value must be a plain object with only an optional plain `server` object and an optional integer `server.port` from 0 through 65535. Arrays, non-object exports, non-plain nested values, accessor fields, unknown keys, and invalid ports reject before `DevServer.start`. Node performs discovery, module evaluation, resolution, and this validation even when the CLI supplies `--port`; the explicit value then wins, otherwise the configured value wins, otherwise 5173 is the default. `0` is exact for either source and reaches the private start options unchanged as their port. rsvite owns a Promise rejection only once the default export or function return is available to the resolver; an earlier unhandled rejection keeps Node's native failure timing and output. A handed native Promise uses the standard handler to retain its rejection reason when that reason can provide text, or a fixed configuration-path description when it cannot. If an own invalid `constructor` blocks handler registration, rsvite reports that TypeError as the configuration error rather than claiming an unavailable underlying rejection reason.
<!-- Author: rsvite-senior-engineer -->

Rust is the canonical-root, listener, lifecycle, and typed-bind-error owner. Node selects one scalar startup value, prints the existing readiness boundary only after Rust binds, and does not watch or reload the configuration while the process runs. The C1 configuration subset excludes other default filenames, paths, modes, `.env` loading, aliases, host or strict-port options, plugins, callbacks across N-API, configuration watching or restart, build, preview, and programmatic APIs.
<!-- Author: rsvite-engineer -->

## C2 selected Plugin API boundary

A project may declare one plugin that transforms the root document before it is served. The configuration accepts an optional `plugins` list holding at most one plain object with exactly a non-empty `name` and a `transformIndexHtml` object of exactly `{ order: "pre", handler }`. Anything else is refused by name before the listener reports readiness: a `plugins` value that is not a list, a second plugin, a nested list, a placeholder entry, a missing or empty name, the function form of the hook, another order, a missing or non-function handler, and any other plugin or hook field. The list is read by what it holds rather than what it computes when asked, so an entry behind a getter, a symbol key, and a key beyond the list's own entries and length are refused as well. A plugin silently dropped is a project that believes its document is being transformed when it is not.
<!-- Author: rsvite-senior-engineer -->

Node runs the handler. Rust reads `index.html` for every `GET /` and owns the response, watching, reloads and the server's lifetime. The handler is called as a plain function with the document as the project wrote it and `{ path: "/index.html", filename }` for the file that request resolves to. Only that text crosses into Rust and only a replacement comes back: no plugin object, configuration value or path context reaches it. The built-in `/@rsvite/client` reference is appended after the hook, so a hook never sees it.
<!-- Author: rsvite-senior-engineer -->

Returning `undefined` or an empty string keeps the document; a non-empty string replaces it. Every other result — a Promise, whether it fulfils or rejects, a tag descriptor, an array, an object, `null`, a number or a boolean — is unsupported at this level and fails that one request. A hook that throws fails that request too, and its text is decided in three steps: a string `message` wins; otherwise the value is asked for its string form; and only a value whose conversion throws is reported by a fixed description. Configuration errors use the same three steps. Either way the reply is one `500` naming the plugin, never the untransformed document, and the server goes on answering the next request. A Promise this server was handed and will not wait for has its rejection taken whether it was returned or thrown, so it cannot end the process. Each request reads the file again and runs the hook again; nothing transformed is kept between requests. A project that declares no hook is answered with its own bytes, and a document that is not text is a controlled failure only when a hook was declared to receive it.
<!-- Author: rsvite-senior-engineer -->

The callback belongs to the server's lifetime. Closing the server and letting go of the last JavaScript wrapper both release it through the same owned shutdown: the listener closes on the server's `Drop` path, the port is free again, and the process that started the server can end. Nothing on the Rust side reaches back to that wrapper, so holding the transformation cannot keep the object that started the server alive.
<!-- Author: rsvite-senior-engineer -->

## Repository boundaries

- Rust workspace members live under `crates/`.
  <!-- Author: rsvite-lead -->
- JavaScript packages live under `packages/`.
  <!-- Author: rsvite-lead -->
- Repository tooling follows the Vite+, pnpm workspace, Cargo workspace, naming, and file-organization conventions established in [taffyjs](https://github.com/hyfdev/taffyjs). Product modules and runtime boundaries are not copied from taffyjs.
  <!-- Author: rsvite-lead -->

## First M1 vertical slice: Rust-served root HTML

### User outcome and limits

The first implementation PR makes `pnpm exec rsvite fixtures/m1-basic-html` start a development server and render that fixture's `index.html` in a browser. This is the smallest durable user path: Vite treats a root `index.html` as the entry served at `/`, while a health endpoint or generated page would prove only that native code can answer a request. The package follows Vite's `vite [root]` command shape, binds to `127.0.0.1`, and supports only the positional root plus `--port` in this slice.
<!-- Author: rsvite-lead -->

The first no-config fixture contains `index.html`, `/src/main.js`, and `/src/message.js`; it has no configuration file, package dependency, plugin, stylesheet, or asset. The Rust server handles `GET /` by reading `<root>/index.html`, appending an absolute `/@rsvite/client` module reference, and returning the response as `text/html; charset=utf-8`. It handles project-contained `.js` and `.ts` requests through the [local module path](#m1-local-javascript-and-typescript-import-slice), project-contained `.css` and `.svg` requests through the resource path, returns `404` for unknown paths, and returns `405` for methods other than `GET`.
<!-- Author: rsvite-senior-engineer -->

Rust reads HTML, JavaScript, TypeScript, stylesheet, and SVG asset files again for each request. A successful root response appends only the built-in `/@rsvite/client` module, which opens `/@rsvite/events`; the one selected `transformIndexHtml` pre hook in the C2 boundary above is the only configurable HTML transform that runs, and it runs before that reference is appended. A Rust watcher groups the notifications of one ordinary edit into a single coarse reload event: a notification about a file this server answers with opens an edit window, each further one extends it, and when the window falls quiet the server sends one event. The built-in client loads the document again unless it is already loading one, so events arriving during a navigation do not add another, and edits to several files inside one window share that window's reload. The quiet interval groups an ordinary burst of notifications; it is not evidence that every writer has finished, and this slice makes no claim about what a page sees while one is still writing. Opening a served file without changing it, metadata-only activity, a directory, a removal and a file no name this server answers for leads to open no window at all. A notification carries the path the filesystem reports, which is not the name a request spells, so what opens a window is whether a name a request may use currently leads to that file and is really answered with it. The way such a name takes may leave the project and come back, because containment is decided on the file a request finally reaches; a module additionally has to be one the server can write a URL for, so a resolved module path that is not text is refused permanently and reloads nothing, while a stylesheet or asset at the same path is returned as the bytes it holds and does reload. A file no such name reaches stays silent however it is written. The project's recursive registration does not follow directory symlinks; a contained file such a name ends at is observed through its canonical project path, which that registration already covers. `GET /` reads `index.html` through whatever links it goes through, and each link that resolution follows, together with the file it ends at, is watched by name in the directory it lives in, including directories outside the project, so editing that file or replacing one of those links is an edit. Replacing a non-symlink ancestor directory of that chain is not observed by this slice. Stylesheets and SVG assets are served as the project wrote them. State-preserving HMR, other HTML transformation, TypeScript syntax beyond variable annotations, TSX/JSX, source maps, CSS parsing and rewriting, asset types other than SVG, build, and preview remain unsupported.
<!-- Author: rsvite-senior-engineer -->

The package exposes no JavaScript API outside the bounded C1 port selection and the one C2 `transformIndexHtml` pre hook it runs on the project's behalf. The npm package exposes a `rsvite` bin but no importable package entry, and its internal native loader is absent from the package export map. The CLI rejects explicit `--config`, `build`, `preview`, and unknown options. It reads only the bounded C1 configuration subset and the one C2 `transformIndexHtml` pre hook defined in the boundaries above; no other Plugin API hook, Runtime API, programmatic API, Vite dev server, Vite module graph, or JavaScript scheduler is loaded or called.
<!-- Author: rsvite-senior-engineer -->

### Package and crate boundaries

- `packages/rsvite` is the user-facing workspace package, with package name and bin `rsvite` for this slice. The private root package is renamed to `@rsvite/workspace` and declares `rsvite: workspace:*` as a development dependency, so the repository command resolves the same bin interface intended for consumer installation. These local package and bin names do not assert ownership of the public unscoped `rsvite` registry name; the publishable package identity is release work. The user-facing package owns argument parsing, C1 configuration discovery, evaluation, resolution, and validation, terminal output, and translation of `SIGINT` or `SIGTERM` into one shutdown request. It reads the selected `vite.config.js` for that scalar configuration subset and for the one accepted plugin, whose hook it validates and runs; it does not own canonical-root resolution, HTTP requests, or server state.
  <!-- Author: rsvite-senior-engineer -->
- `crates/rsvite_binding` is a `cdylib` and the only crate that depends on `napi`, `napi-derive`, or Node-API types. It converts the internal startup options and errors and wraps the Rust server handle for the package's private loader.
  <!-- Author: rsvite-lead -->
- `crates/rsvite_core` is an ordinary Rust library with no Node-API dependency. It owns root resolution and validation, the HTTP listener, request handling, lifecycle state, and shutdown. Its public Rust boundary can be tested without Node, but direct Rust invocation is not product acceptance.
  <!-- Author: rsvite-lead -->

The first PR builds the local native module needed by repository tests. Platform-specific npm packages, a published support matrix, and packed-package replacement checks remain release work; adding them must not move project execution or state into the npm package.
<!-- Author: rsvite-lead -->

### Private N-API lifecycle

`rsvite_binding` exposes a private Rust-backed `DevServer` class. Its asynchronous `start({ root, port, transformIndexHtml })` factory resolves only after Rust has validated the root and bound the loopback listener; the optional transformation is the one call Rust makes back into Node, taking the document as a string and returning its replacement as a string; its read-only address identifies the actual bound port. `wait()` resolves after an intentional close and rejects if the running server fails. `close()` asks Rust to stop accepting requests and waits for in-flight requests and the server task. These methods are an internal CLI-to-Rust boundary, not a supported rsvite or Vite programmatic API.
<!-- Author: rsvite-senior-engineer -->

The binding uses the Tokio runtime managed by `napi-rs`; it does not create a JavaScript HTTP server or a second native executor. `rsvite_core::DevServer` is the sole owner of the canonical root, bound address, listener task, file watcher, the work that groups edits into reloads, update work, open event streams, and `starting` / `running` / `closing` / `closed` state. A server stops for one of three reasons — a caller asks it to, the watcher fails, or the listener ends — and each registers itself where it happens, so the first registration is the one that began the shutdown. One task owns the rest: it publishes a state every open and newly routed stream reads, stops the watcher, closes the listener, waits for the work that groups edits and the work that forwards reloads, and only then publishes the final state. What a caller is told is that reason unless the listener itself reported an error or ended without a result, which describes the closing work more precisely and is reported instead. The JavaScript object holds only the Rust handle. That handle is the only way to ask the server to stop and cannot be copied, so letting go of it registers the same close request a caller would make: a wrapper collected without `close()` ends the listener, the watcher and their tasks rather than leaving them running with nobody able to reach them, and because the request goes into the same first-cause slot, an earlier close or failure still decides what the server ends as. The CLI keeps that handle alive, races `wait()` against the two termination signals, calls `close()` on a signal, and reports completion only after Rust has closed the listener.
<!-- Author: rsvite-senior-engineer -->

Configuration discovery, module evaluation and resolution, and C1-subset validation fail in Node before `DevServer.start`; the CLI prints one diagnostic and starts no Rust listener. Once that private start call begins, startup and lifecycle failures originate as typed Rust errors. The binding converts a startup error into rejection of `start`, a running-server error into rejection of `wait`, and a shutdown error into rejection of `close`; the CLI prints one diagnostic and exits nonzero. A missing `index.html` is a request result and returns `404`, while another read failure returns `500`. JavaScript does not replace either response or continue with a fallback server.
<!-- Author: rsvite-engineer -->

The lifecycle shape follows the documented `napi-rs` support for a Rust-backed stateful [class](https://napi.rs/docs/concepts/class), asynchronous methods, and Promise rejection from Rust [`Result`](https://napi.rs/docs/concepts/error-handling). The command and root mapping follow Vite's documented [`vite [root]`](https://vite.dev/guide/cli) entry and [`<root>/index.html` to `/`](https://vite.dev/guide/features.html#html) behavior.
<!-- Author: rsvite-lead -->

### Acceptance

The focused acceptance command is `pnpm exec vp run test:m1:html`. It builds the native module and runs the JavaScript, TypeScript, stylesheet-and-asset, and selected-C2 plugin fixtures through the public CLI on isolated ports. Every browser loads `/` without a page or console error. The M1 fixtures then observe an edit without a restart: the module fixtures receive Rust-transformed modules and render the imported value, then see a dependency edit; the stylesheet-and-asset fixture renders the declared colour and loads the SVG the stylesheet names, then sees each file's new bytes. The selected-C2 fixture loads once and edits nothing: it proves the wrapped document, the built-in client after the hook, the context the hook was given, and the project file left as it was. Separate checks prove an edit reaches the page on its own, from a dependency written in place, a dependency and a root document replaced by rename, an asset and a stylesheet edited in their own windows, an edit written in pieces through one handle, a dependency replaced by a file written and closed outside the project, a document that lives outside the project, and an edit made while a directory the project links to but does not contain is being written. Each is decided by a main-frame navigation and by the loss of a value held only on the previous document, never by asking the page to reload. A second acceptance drives the same command and reads its reload stream and HTTP responses directly, so how many reloads one edit window produces is exact: an ordinary edit reloads once and the next edit is its own reload, edits made together share one, a temporary written and closed before its rename reloads once, a document outside the project reloads when it is written, replaced or pointed elsewhere and stops mattering once it is not on the way, every link on the way to it is watched wherever it leads, an edit made through a link the route answers for reloads once although the path it lands on is one no request may spell while that path asked for directly stays a refusal and reloads nothing, a name that leaves the project and comes back to a project file is answered `200` and its edit reloads once while a resolved module path that is not text stays a `400` that reloads nothing and a stylesheet at the same path is served and does reload, and opening a served file without changing it, a permission change, an unsupported path, a directory rename and a removal reload nothing. A private-binding check starts a server, lets the JavaScript wrapper be collected without calling `close()`, confirms the collection through a `FinalizationRegistry`, and proves the old address stops answering and can be bound again. The JavaScript check proves its extensionless import is rewritten to `.js`; the TypeScript check proves its extensionless import is rewritten to `.ts` and variable annotations are absent from both served modules. The lifecycle checks send `SIGTERM` or `SIGINT`, require a zero exit, and prove that the same address can be rebound.
<!-- Author: rsvite-senior-engineer -->

The implementation depends on [Issue #2](https://github.com/hyfdev/rsvite/issues/2) for the compatibility contract, [Issue #3](https://github.com/hyfdev/rsvite/issues/3) for shared process and browser orchestration, and [Issue #4](https://github.com/hyfdev/rsvite/issues/4) for the exact Vite source pin and imported files. Issue #4 imports `playground/html/__tests__/html.spec.ts`, `playground/html/index.html`, and `playground/html/vite.config.js` without changing them. The selected `main > preserve comments` test requires C2 `transformIndexHtml`: Vite loads the hook, while the paired C0 binding-level replay starts the private `DevServer` directly and does not discover configuration or call the Plugin API. A public C1 CLI run at this root rejects its unsupported top-level `input` key before Rust starts.
<!-- Author: rsvite-engineer -->

The imported files live under `corpus/vite-upstream/` at Vite `ee644014aab61e546742b862a7d7b0d6c7d67a7b`. `@rsvite/compatibility-vite-upstream` records their provenance and exports `htmlPreserveCommentsAdapter`, which names the spec, imported root, and selected test without editing the vendored files.
<!-- Author: rsvite-lead -->

`pnpm exec vp run record:rsvite-upstream:baseline` records the selected case first with Vite and then with rsvite. Both executions use the same clean external pin, lockfile, Node version, runner image, and pinned Playwright Chromium. The Vite result records C2, `html` owned by Vite, and a pass. The rsvite result records C0, `html` owned by Rust, no fallback, and a failure during the unchanged test: Vite's config hook places both comments in the body, while the raw rsvite response leaves the first comment in the browser's implicit head. This is a Plugin API compatibility requirement, not an HTML transform inside the raw slice.
<!-- Author: rsvite-lead -->

The rsvite result identifies the committed `packages/rsvite` name, version, and exact workspace source commit. Before the paired task builds the binding or replaces either result, it rejects invalid package metadata and staged, unstaged, or untracked product-source changes.
<!-- Author: rsvite-lead -->

`pnpm exec vp run test:m1:html` builds the native module, runs the positive JavaScript, TypeScript, stylesheet-and-asset, C1 configuration, and selected-C2 plugin package fixtures — the last covering the accepted hook shape, its refusals, its failure and recovery behavior, and a Chromium fixture that loads the wrapped document — verifies imported-file provenance and both committed compatibility results, and confirms the C0 binding-level outcome against the vendored test. It does not clone or install the external checkout or replace committed results. `pnpm exec vp run ready` depends on this focused task; a green run means the current product's C0 replay path, C1 package checks, selected-C2 hook checks, and recorded compatibility facts satisfy their contracts. It does not mean rsvite passes the pinned upstream case, which needs configuration fields, hook forms and tag injection this level does not support.
<!-- Author: rsvite-senior-engineer -->

The core acceptance also tests that a missing root and a busy requested port reject startup; missing files, unknown paths, non-`GET` requests, and file-read failures produce the declared HTTP responses; and an explicit `--config` path, `build`, `preview`, an unknown option, an import of the package root, and an import of the private loader all fail. The C1 package tests separately cover default-file discovery, config-export resolution and validation, port precedence, and startup failure before Rust. The local module slice runs bare and URL imports, traversal and symlink escape, directories, unsupported file types, missing modules, dynamic imports, and parser-reported diagnostics through both accepted extensions. TypeScript tests also require parser or transformation failure to preserve the importer's last successful outgoing edges.
<!-- Author: rsvite-engineer -->

### Options considered

- A Node HTTP server that calls Rust for response bytes would shorten the first Rust module, but Node would own the listener, request scheduling, and shutdown. It violates the fixed execution-ownership rule.
  <!-- Author: rsvite-lead -->
- A Rust child process would make shutdown isolation straightforward, but the user path would be Node to a process boundary rather than Node to Rust through `napi-rs`. It does not prove the adopted product entry.
  <!-- Author: rsvite-lead -->
- One `cdylib` containing both Node conversion and the server would reduce the initial crate count, but Node-API types and lifecycle would become the core's test and dependency boundary. Splitting the ordinary Rust library from the thin binding preserves direct Rust tests and keeps future HTTP, graph, watcher, and build code independent of Node.
  <!-- Author: rsvite-lead -->
- One long-running `runDevServer()` Promise would expose fewer internal methods, but it would not separately report readiness, the assigned port, running-server failure, and deterministic close. The private Rust-backed handle adds a small internal surface and makes all four states observable to the CLI and tests.
  <!-- Author: rsvite-lead -->

### Reopening the decision

Reopen the private lifecycle shape if a repeatable Node worker, garbage-collection, start/close stress, or process-teardown test shows a hang, leaked listener, task running after environment cleanup, or failure that cannot reach `wait()`. Reopen the package loader layout if clean packed-package tests show that the native binary cannot be selected for a declared platform. Either result may change the handle or loader, but it does not by itself authorize a JavaScript-owned server or a child-process entry.
<!-- Author: rsvite-lead -->

The private start object is `{ root, port, transformIndexHtml }`. The C1 port-selection subset proves that carrying one validated scalar there is sufficient for a configuration value of that shape. Reopen the core/binding input boundary when a later configuration or plugin behavior cannot cross it while preserving call order, cancellation, errors, and Rust state ownership; adding later Rust handlers, a module graph, watching, or HMR behind the same Rust owner does not reopen it by itself.
<!-- Author: rsvite-senior-engineer -->

## M1 local JavaScript and TypeScript import slice

The two no-config fixtures keep `index.html` as the entry and load either `/src/main.js` or `/src/main.ts` as a browser module. Each entry imports `./message` without an extension, so the browser cannot execute either fixture by treating Rust as a static file server: rsvite must resolve the dependency, rewrite its browser URL, and transform TypeScript before responding. Each imported value renders into `#app` through the same public Node CLI and private N-API lifecycle as the HTML slice.
<!-- Author: rsvite-architect -->

For each `.js` or `.ts` request, `rsvite_core` canonicalizes the requested file inside the canonical project root, reads it, and uses Oxc's Rust parser to obtain its static module requests. Relative and root-relative imports resolve in Rust. An explicit `.js` or `.ts` extension selects only that path; an extensionless import tries `.js` and then `.ts`. Transformed source contains root-relative, percent-encoded browser URLs. Bare and URL imports, dynamic imports, queries or fragments, traversal, symlink escape, directories, other file types, missing modules, and parser-reported diagnostics fail the request explicitly. No Vite core or JavaScript resolver is consulted.
<!-- Author: rsvite-architect -->

For `.ts`, the same Oxc parse identifies type annotations attached to variable declarations. Rust removes those spans while rewriting import specifiers, then rejects retained TypeScript class metadata and requires TypeScript-module and JavaScript-module parses of the response to have matching span-independent AST content. A parser diagnostic, retained class modifier, or different program shape means unsupported TypeScript syntax remains, so the request fails before graph state changes or response bytes. Other TypeScript syntax, TSX/JSX, and source maps are outside this slice.
<!-- Author: rsvite-architect -->

A successful transformation replaces that importer's outgoing edges in a Rust-owned directed graph. Each edge retains the importer and its resolved importee. The graph is deliberately limited to module identity: watcher timestamps, invalidation, transforms, HMR boundaries, and scheduling remain later decisions.
<!-- Author: rsvite-architect -->

JavaScript and transformed TypeScript responses use `text/javascript; charset=utf-8` and `Cache-Control: no-store`. Source and imports are read, analyzed, and transformed again on every request, so the document load that follows a save observes a dependency edit without a restart. The Node package owns CLI behavior, the binding translates lifecycle calls, and the core owns project-file access, parsing, resolution, transformation, and graph state.
<!-- Author: rsvite-senior-engineer -->

A source-text pattern matcher was rejected because comments, strings, escapes, re-exports, and evolving JavaScript syntax would make false dependency edges and unsafe rewrites easy. A full Rust parser adds compile-time weight, but it makes the spans and decoded module specifiers authoritative while keeping execution ownership on the adopted side of the boundary.
<!-- Author: rsvite-architect -->

Stylesheet and SVG asset requests name their own extension and take no part in extensionless module resolution, so the `.js`-then-`.ts` table stays as it is; reopen it when the bare-package leaf introduces candidates that compete for the same extensionless specifier. Reopen the TypeScript transformation when evidence selects another syntax or source maps. Reopen the per-request graph replacement when watching or HMR needs versioned transform state, but do not move analysis, resolution, transformation, or graph ownership into Node as part of those changes.
<!-- Author: rsvite-senior-engineer -->

## Serving project resources

A request path names the kind of file it accepts, and one resolver answers that question for every kind. A resource request carries a stricter decoding contract than a module request. The kind comes from reading the path as text, which names a kind and nothing else; the file comes from a separate strict decoding of the same request, the only decoded value that reaches the resolver and the filesystem, where an escape that is not two hexadecimal digits makes the request malformed rather than a filename. A path whose raw suffix is `.js` or `.ts` enters the module route and decodes under the module rules; a path that names no kind this server answers is an empty `404` whatever its encoding does. The shared resolver reports a failure to canonicalize a module-graph file under the same noun for a request and for an import. The resolver then refuses empty, `.`, `..`, backslash and NUL segments rather than normalising them, canonicalizes the candidate, requires the canonical file to stay inside the canonical project root, and requires it to be one of the kinds the request accepts. The extension is checked before the filesystem is touched and again on what the request truly resolved to, so an in-root link cannot deliver a different kind of file than the one asked for. Modules accept `.js` and `.ts`; a stylesheet request accepts only `.css` and an asset request only `.svg`.
<!-- Author: rsvite-senior-engineer -->

Stylesheets are returned as `text/css; charset=utf-8` and SVG assets as `image/svg+xml`, both with `Cache-Control: no-store` and both re-read on every request, so the document load that follows an edit observes the new bytes without a restart. Rust does not parse or rewrite CSS: the browser resolves a stylesheet's own relative URLs and rsvite answers the requests they produce, which is why this slice adds no CSS-to-asset graph edge. A request for an extension no kind accepts is a `404`; it never becomes a general static-file fallback.
<!-- Author: rsvite-senior-engineer -->

## Open architecture questions

- How a later configuration value that cannot fit the private start options crosses the N-API boundary. Those options carry the root, the selected port, and the one optional string-to-string transformation.
  <!-- Author: rsvite-senior-engineer -->
- Whether runtime JavaScript, and plugin hooks beyond the selected `transformIndexHtml` pre hook, execute in-process or in a supervised process. That hook runs in the CLI's own process, and reopening its placement needs evidence that in-process execution cannot hold.
  <!-- Author: rsvite-senior-engineer -->
- How Rust calls JavaScript hooks beyond the selected `transformIndexHtml` pre hook, and preserves ordering, cancellation, errors, and state ownership for them. That hook is called once per root request through the binding's caught path, so a hook failure is one response rather than a stopped process, and Rust keeps every piece of server state.
  <!-- Author: rsvite-senior-engineer -->
- How SSR and environment runtimes execute JavaScript modules.
  <!-- Author: rsvite-lead -->
- How the M1 import graph evolves to represent transform versions, invalidation boundaries, and HMR propagation.
  <!-- Author: rsvite-architect -->
- Where Rolldown integrates with development and production execution.
  <!-- Author: rsvite-lead -->

An implementation decision may choose any answer that preserves the fixed product boundary. A decision that changes the Node entry or returns substantive execution and state to JavaScript changes the adopted product definition and must be treated as a product-direction change.
<!-- Author: rsvite-lead -->
