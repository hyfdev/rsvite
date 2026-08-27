# Architecture

rsvite has a fixed product entry and execution-ownership rule. The detailed process model, callback protocol, module graph, and runtime implementation remain open until implementation evidence selects them.
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
