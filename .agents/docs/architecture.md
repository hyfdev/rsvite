# Architecture

rsvite has a fixed product entry and execution-ownership rule. The first M1 slice below also fixes its Node/N-API/Rust process boundary and native server lifecycle. Plugin and runtime JavaScript placement, the cross-language callback protocol, the module graph implementation, and later capability internals remain open until implementation evidence selects them.
<!-- Author: rsvite-lead -->

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

The fixture contains one `index.html` with the title `rsvite M1 HTML` and one element `<h1 id="app">served by Rust</h1>`. It contains no configuration file, package dependency, plugin, script, stylesheet, or asset. The server handles `GET /` by reading `<root>/index.html` in Rust for each request and returning its bytes as `text/html; charset=utf-8`. Other paths return `404`, and other methods return `405`; neither response enters JavaScript.
<!-- Author: rsvite-lead -->

Reading the file per request lets a manual browser reload observe an edit without adding a cache or watcher. Automatic reload, HMR, HTML transformation, JavaScript or TypeScript transformation, CSS, assets, module resolution, file watching, build, and preview remain unsupported. Those capabilities extend this boundary in later M1 leaves; they are not acceptance criteria for the first implementation PR.
<!-- Author: rsvite-lead -->

C0 fails closed for JavaScript APIs. The npm package exposes a `rsvite` bin but no importable package entry, and its internal native loader is absent from the package export map. The CLI rejects `--config`, `build`, `preview`, and unknown options, and neither Node nor Rust discovers or reads a Vite configuration file. No Vite configuration, Plugin API hook, Runtime API, programmatic API, Vite dev server, Vite module graph, or JavaScript scheduler is loaded or called.
<!-- Author: rsvite-lead -->

### Package and crate boundaries

- `packages/rsvite` is the user-facing workspace package, with package name and bin `rsvite` for this slice. The private root package is renamed to `@rsvite/workspace` and declares `rsvite: workspace:*` as a development dependency, so the repository command resolves the same bin interface intended for consumer installation. These local package and bin names do not assert ownership of the public unscoped `rsvite` registry name; the publishable package identity remains release work and must be resolved before publishing. The user-facing package owns argument parsing, terminal output, and translation of `SIGINT` or `SIGTERM` into one shutdown request. It does not read project files, accept HTTP requests, or own server state.
  <!-- Author: rsvite-lead -->
- `crates/rsvite_binding` is a `cdylib` and the only crate that depends on `napi`, `napi-derive`, or Node-API types. It converts the internal startup options and errors and wraps the Rust server handle for the package's private loader.
  <!-- Author: rsvite-lead -->
- `crates/rsvite_core` is an ordinary Rust library with no Node-API dependency. It owns root resolution and validation, the HTTP listener, request handling, lifecycle state, and shutdown. Its public Rust boundary can be tested without Node, but direct Rust invocation is not product acceptance.
  <!-- Author: rsvite-lead -->

The first PR builds the local native module needed by repository tests. Platform-specific npm packages, a published support matrix, and packed-package replacement checks remain release work; adding them must not move project execution or state into the npm package.
<!-- Author: rsvite-lead -->

### Private N-API lifecycle

`rsvite_binding` exposes a private Rust-backed `DevServer` class. Its asynchronous `start({ root, port })` factory resolves only after Rust has validated the root and bound the loopback listener; its read-only address identifies the actual bound port. `wait()` resolves after an intentional close and rejects if the running server fails. `close()` asks Rust to stop accepting requests and waits for in-flight requests and the server task. These methods are an internal CLI-to-Rust boundary, not a supported rsvite or Vite programmatic API.
<!-- Author: rsvite-lead -->

The binding uses the Tokio runtime managed by `napi-rs`; it does not create a JavaScript HTTP server or a second native executor. `rsvite_core::DevServer` is the sole owner of the canonical root, bound address, listener task, and `starting` / `running` / `closing` / `closed` state. The JavaScript object holds only the Rust handle. The CLI keeps that handle alive, races `wait()` against the two termination signals, calls `close()` on a signal, and reports completion only after Rust has closed the listener.
<!-- Author: rsvite-lead -->

Startup and lifecycle failures originate as typed Rust errors. The binding converts a startup error into rejection of `start`, a running-server error into rejection of `wait`, and a shutdown error into rejection of `close`; the CLI prints one diagnostic and exits nonzero. A missing `index.html` is a request result and returns `404`, while another read failure returns `500`. JavaScript does not replace either response or continue with a fallback server.
<!-- Author: rsvite-lead -->

The lifecycle shape follows the documented `napi-rs` support for a Rust-backed stateful [class](https://napi.rs/docs/concepts/class), asynchronous methods, and Promise rejection from Rust [`Result`](https://napi.rs/docs/concepts/error-handling). The command and root mapping follow Vite's documented [`vite [root]`](https://vite.dev/guide/cli) entry and [`<root>/index.html` to `/`](https://vite.dev/guide/features.html#html) behavior.
<!-- Author: rsvite-lead -->

### Acceptance

The focused acceptance command is `pnpm exec vp run test:m1:html`. The task builds the native module, starts the CLI on an isolated port, and loads `/`. The response must be `200` with the HTML content type, the page title must be `rsvite M1 HTML`, `#app` must contain `served by Rust`, and the browser must report no page or console error. The task changes that text to `served by Rust again`, reloads the page, and requires the new text, proving that Rust reads the file for each request. It then sends `SIGTERM`, requires a zero exit, and proves that the same address can be rebound.
<!-- Author: rsvite-lead -->

The implementation PR depends on [Issue #2](https://github.com/hyfdev/rsvite/issues/2) for the compatibility contract, [Issue #3](https://github.com/hyfdev/rsvite/issues/3) for shared process and browser orchestration, and [Issue #4](https://github.com/hyfdev/rsvite/issues/4) for the exact Vite source pin and imported files. Issue #4 imports `playground/html/__tests__/html.spec.ts` and its required fixtures without changing them. The exact upstream acceptance is the test `main > preserve comments`; an external rsvite adapter starts the Rust server for that imported root, and the test file and expectation remain unchanged.
<!-- Author: rsvite-lead -->

`pnpm exec vp run test:m1:html` runs that exact upstream case once with the pinned Vite implementation and once with rsvite, then records both executions against the Issue #4 `vite-upstream-e2e` manifest entry. The rsvite result must record C0, `html` owned by Rust, and no fallback. The local `fixtures/m1-basic-html` smoke test is not a corpus entry and does not produce a compatibility result. `pnpm exec vp run ready` depends on this focused task once the implementation lands.
<!-- Author: rsvite-lead -->

The first implementation PR also tests that a missing root and a busy requested port reject startup; a missing `index.html`, an unknown path, a non-`GET` request, and another file-read failure produce the declared HTTP responses; and `--config`, `build`, `preview`, an unknown option, an import of the package root, and an import of the private loader all fail.
<!-- Author: rsvite-lead -->

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

Reopen the core/binding input boundary when the first accepted C1 configuration or plugin behavior cannot cross it while preserving call order, cancellation, errors, and Rust state ownership. Adding later M1 handlers, a module graph, watching, or HMR behind the same Rust owner does not reopen this decision.
<!-- Author: rsvite-lead -->

## Open architecture questions

- How supported Vite configuration values cross the N-API boundary.
  <!-- Author: rsvite-lead -->
- Whether plugin and runtime JavaScript execute in-process or in a supervised process.
  <!-- Author: rsvite-lead -->
- How Rust calls JavaScript hooks and preserves ordering, cancellation, errors, and state ownership.
  <!-- Author: rsvite-lead -->
- How SSR and environment runtimes execute JavaScript modules.
  <!-- Author: rsvite-lead -->
- Which data structures and algorithms implement the module graph and HMR.
  <!-- Author: rsvite-lead -->
- Where Rolldown integrates with development and production execution.
  <!-- Author: rsvite-lead -->

An implementation decision may choose any answer that preserves the fixed product boundary. A decision that changes the Node entry or returns substantive execution and state to JavaScript changes the adopted product definition and must be treated as a product-direction change.
<!-- Author: rsvite-lead -->
