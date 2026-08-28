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

M1 serves browser JavaScript and removes TypeScript variable declaration annotations through Rust-owned static-import analysis and transformation, local `.js`-then-`.ts` resolution and rewrite, and a directed importer-to-importee graph. It also serves project-contained stylesheets and SVG assets as raw bytes with declared content types, re-read on every request. A full reload proves that dependency, stylesheet and asset edits reach the browser. Other TypeScript syntax, TSX/JSX, source maps, CSS parsing and `@import`, other asset types, packages, watching, automatic reload, and HMR remain later evidence-scoped leaves. Current-product replay validates the advancing product against the compatibility fact recorded by the committed C0 result.
<!-- Author: rsvite-senior-engineer -->

## Later directions

- Establish the C1 configuration bridge: Node loads Vite configuration and passes the supported values through `napi-rs`; the representation follows the first selected configuration behavior rather than a preselected serialization format.
  <!-- Author: rsvite-lead -->
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
