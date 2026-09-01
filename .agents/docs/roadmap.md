# Roadmap

Milestones are adjustable plans rather than permanent contracts. Real-project failures, Vite upstream tests, implementation results, and performance data may split, merge, reorder, add, or remove milestones. GitHub records the reason and evidence for each change.
<!-- Author: rsvite-lead -->

Only the active milestone and the next executable leaf issues receive detailed scope. Later directions remain broad until evidence determines their order.
<!-- Author: rsvite-lead -->

## M0 — Compatibility evidence

Pin a Vite upstream commit and encode the three fixed real-project commits from [compatibility.md](compatibility.md) in the reproducible corpus. Establish a reproducible runner, result format, original Vite baselines, failure classification, execution-owner record, and the pilot data needed to fix a formal performance protocol.
<!-- Author: rsvite-lead -->

M0 is complete when both evidence sources run from fixed inputs; every result identifies its exact source commit, environment, command, pass or failure, first incompatible behavior, and execution owner; upstream source and license are preserved; pilot runtime, variation, cache/order, and memory observations fix the formal comparison protocol; and correctness remains separate from performance conclusions.
<!-- Author: rsvite-lead -->

## M1 — Node-started Rust dev core at C0

Node/npm starts Rust through `napi-rs`. For a no-config, no-plugin fixture, Rust provides the first vertical development path for HTML, basic JavaScript/TypeScript, CSS, assets, resolution, file watching, and basic updates. Selected Vite upstream E2E and browser checks verify the path, and the capability-owner record confirms that Vite or JavaScript core execution is not used as an undeclared fallback.
<!-- Author: rsvite-lead -->

M1 leaf issues are created incrementally. The first architecture issue fixes the smallest vertical slice and internal boundaries; the first implementation issue then establishes the Node → `napi-rs` → Rust path. Later M1 issues depend on evidence from those changes and M0 rather than a speculative full decomposition.
<!-- Author: rsvite-lead -->

M1 serves browser JavaScript and removes TypeScript variable declaration annotations through Rust-owned static-import analysis and transformation, local `.js`-then-`.ts` resolution and rewrite, and a directed importer-to-importee graph. It also serves project-contained stylesheets and SVG assets as raw bytes with declared content types, re-read on every request. A Rust watcher groups each edit window on that file surface into one coarse reload event on every open stream, and the built-in client answers it by loading the document again unless it is already loading one, which is how dependency, stylesheet, asset and root-document edits reach the browser. Other TypeScript syntax, TSX/JSX, source maps, CSS parsing and `@import`, other asset types, packages, and state-preserving HMR remain later evidence-scoped leaves. Current-product replay validates the advancing product against the compatibility fact recorded by the committed C0 result.
<!-- Author: rsvite-senior-engineer -->

## First C1 configuration slice

The first C1 configuration slice has Node as the one-time configuration evaluator and Rust as the development-server owner. Node searches only Vite's default config filename order, initializes a missing or empty `NODE_ENV` to `development` before native module evaluation, and preserves a nonempty parent value. A native static-import wrapper preserves the real module namespace without executing a callable `then`. A `vite.config.js` ESM default export or CommonJS `module.exports` may be a direct value, Promise, or synchronous or asynchronous function called once with the development `ConfigEnv`; its resolved value must be the bounded plain-object `server.port` subset. Node validates it before the N-API start call and passes the chosen port unchanged. Promise rejection becomes an rsvite configuration error only after that Promise has reached the resolver; an earlier unhandled rejection keeps Node's native failure, a handed Promise keeps its reason when that reason can provide text, a reason that cannot provide text reports a fixed configuration-path description, and a handed Promise with an own invalid `constructor` reports its handler-registration TypeError. An explicit CLI port wins after the same discovery, evaluation, and validation; an absent config uses 5173; `0` is ephemeral; unsupported first-found filenames, resolved values, fields, load errors, and busy requested ports fail rather than silently falling back or scanning.
<!-- Author: rsvite-engineer -->

This configuration slice is intentionally not a generic configuration layer: explicit paths, TypeScript/config bundling, mode selection, `.env` loading, aliases, host and strict-port settings, plugins, callbacks, config-file watching or restart, build, preview, and programmatic APIs stay later evidence-scoped work.
<!-- Author: rsvite-engineer -->

## Later directions

- Expand C1 only from a new evidence-scoped configuration behavior that preserves the C1 static-port boundary and records any necessary N-API representation decision.
  <!-- Author: rsvite-engineer -->
- Pass DrawDB with the React/JSX/HMR and Plugin API behavior it actually requires.
  <!-- Author: rsvite-lead -->
- Expand build and preview, using Rolldown where the selected architecture makes it appropriate.
  <!-- Author: rsvite-lead -->
- Let Actual Budget failures set the order for monorepo, worker, custom-plugin, and build-extension support.
  <!-- Author: rsvite-lead -->
- Let ELK failures set the order for Nuxt configuration, Plugin API, programmatic API, SSR, and PWA support.
  <!-- Author: rsvite-lead -->
- Publish an explicit compatibility matrix as the upstream-test, template, plugin, framework, and real-project corpus grows.
  <!-- Author: rsvite-lead -->

These directions are not numbered milestones until current evidence makes their order actionable.
<!-- Author: rsvite-lead -->
