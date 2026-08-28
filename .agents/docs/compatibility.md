# Compatibility and validation

rsvite tracks product capability and Vite JavaScript API compatibility separately. A milestone or release reports both so that a working dev server is not mistaken for API compatibility and an isolated API hook is not mistaken for a working product. The [architecture record](architecture.md#fixed-product-boundary) defines execution ownership, and the [intent record](intent.md#benefit-hypothesis) defines when measured results support the project's benefit hypothesis.
<!-- Author: rsvite-lead -->

## Product capability

Product capability records observable behavior: HTML entry discovery and serving, supported modules and assets, resolution, errors, file watching, HMR without full-page reload, build and preview output, workers, SSR, and framework lifecycle behavior.
<!-- Author: rsvite-senior-engineer -->

## JavaScript API levels

- **C0 — no Vite JavaScript API:** Node starts rsvite through `napi-rs`; Vite configuration, Plugin API, Runtime API, and programmatic API are unsupported.
  <!-- Author: rsvite-lead -->
- **C1 — config bridge:** Node reads Vite configuration and passes the relevant supported configuration to Rust through `napi-rs`. The transport is not limited to serializable static data; the first supported behavior that needs a representation determines it. C1 does not imply plugin hooks, runtime execution, or programmatic APIs.
  <!-- Author: rsvite-lead -->
- **C2 — selected Plugin API:** high-value hooks are added from blocking evidence in real projects and Vite upstream tests. Each supported hook records its arguments, result, order, error behavior, and Rust/JavaScript owner.
  <!-- Author: rsvite-lead -->
- **C3 — selected Runtime and programmatic API:** runtime, environment, SSR, and JavaScript programmatic behavior are added from framework and application evidence.
  <!-- Author: rsvite-lead -->

## Corpus and result contract

Every validation input and every raw result is recorded through the versioned contract in [packages/compatibility-contract](../../packages/compatibility-contract). Its JSON Schemas are the normative definition of document shape, and its canonical validator is the normative enforcement of the schemas together with the invariants JSON Schema cannot express — a result must name an entry the manifest contains, restate that entry's exact commit, stay at or below the level the entry declares, and report ownership that does not contradict its own declared fallbacks. A source pinned to a moving reference, a result missing its correctness outcome, capability ownership or measured API level, an HMR check with a persisted sentinel, and a measurement missing its cache state and run order all fail validation instead of becoming evidence. One result covers one command run, so it owns a subset of the entry's target capabilities; coverage of an entry as a whole is a question across results. `contractVersion` covers both the shapes and those semantics, so a consumer in another language cannot produce valid evidence from the schemas alone. Runners and project adapters consume that contract rather than defining a per-project result format, and an adapter extends it through its own namespaced key instead of editing vendored upstream sources or expectations.
<!-- Author: rsvite-senior-engineer -->

## Required evidence sources

### Vite upstream E2E

- Pin an exact Vite upstream commit and preserve its license and source commit.
  <!-- Author: rsvite-lead -->
- The current pin is Vite [`ee644014aab61e546742b862a7d7b0d6c7d67a7b`](https://github.com/vitejs/vite/tree/ee644014aab61e546742b862a7d7b0d6c7d67a7b). The imported slice contains `playground/html/__tests__/html.spec.ts`, `playground/html/index.html`, and `playground/html/vite.config.js`. Vite's pass for `main > preserve comments` depends on the config's `transformIndexHtml` hook, so the entry requires C2; a C0 rsvite run is negative compatibility evidence rather than positive acceptance for raw HTML serving. The preserved license is MIT at `LICENSE`. Unrecorded edits to imported files fail the provenance check in `@rsvite/compatibility-vite-upstream`.
  <!-- Author: rsvite-lead -->
- Keep imported tests and fixtures unchanged whenever practical. rsvite runners, adapters, and result classification live outside the vendored tests.
  <!-- Author: rsvite-lead -->
- Do not change upstream expectations to manufacture a pass.
  <!-- Author: rsvite-lead -->
- Classify a failure as a current compatibility requirement, a justified low-priority gap, or a test coupled to Vite internals, and preserve the evidence for that classification.
  <!-- Author: rsvite-lead -->

### Pinned real projects

- [DrawDB at `031aef1f1c1d3f9027ccfacbf084e9c1a31b8abc`](https://github.com/drawdb-io/drawdb/tree/031aef1f1c1d3f9027ccfacbf084e9c1a31b8abc) is the ordinary direct Vite/React application gate.
  <!-- Author: rsvite-lead -->
- [Actual Budget at `766cc8a7244c35f575ecc33a7a718b060cb5d496`](https://github.com/actualbudget/actual/tree/766cc8a7244c35f575ecc33a7a718b060cb5d496) is the complex React monorepo gate, including existing browser E2E, workers, multiple packages, configuration functions, custom plugins, and complex build behavior.
  <!-- Author: rsvite-lead -->
- [ELK at `ae4ebf3375eb68f1f355390b4f163adb10f5026c`](https://github.com/elk-zone/elk/tree/ae4ebf3375eb68f1f355390b4f163adb10f5026c) is the Vue/Nuxt JavaScript API and framework-integration gate, including Nuxt's programmatic Vite use, config extension, SSR, PWA, and Nitro build paths.
  <!-- Author: rsvite-lead -->

A project's Vite major is not a selection gate. Each project keeps its exact commit, lockfile, and dependency graph so that making that application run under rsvite is reproducible compatibility evidence.
<!-- Author: rsvite-lead -->

Focused fixtures and create-vite templates may isolate a failure or provide a fast smoke test, but they do not replace Vite upstream E2E and pinned real projects.
<!-- Author: rsvite-lead -->

## Acceptance rules

### Historical recordings and current-product replay

A committed rsvite result and its logs describe the product source named by `subject.commit`; later product work does not rewrite those historical bytes merely to move that SHA forward. Daily validation reads the package name and version from that recorded commit, requires the SHA itself to identify the product source, and requires it to remain in the current product-source ancestry. It does not require the newest C0 product tree to be byte-identical to the recorded tree. The supported recorder continues to require a clean committed product tree and records its exact source when a new measurement is intentionally made.
<!-- Author: rsvite-architect -->

Currentness comes from replaying the unchanged input against the current product build. For the pinned HTML case, the live replay and committed artifact use the same whole-execution validator and must both fail only at the accepted C2 `transformIndexHtml` assertion. A product change is therefore allowed to preserve historical evidence when the exact behavior still reproduces; any different failure, extra failure, or unexpected pass makes the daily gate fail and requires an explicit compatibility decision rather than an automatic re-recording.
<!-- Author: rsvite-architect -->

### HMR update ownership

For a run that claims `hmr-without-full-reload`, the shared runner owns the manifest-declared `browserAcceptance.hmr.edit` and restores the original file before the run returns. The v1 manifest requires `edit` and `expectedText`. With no adapter override, the runner applies the declared find/replace and waits for `expectedText` to change from absent to present; it rejects a default check whose expected text was already present because that would not prove the edit reached the page.
<!-- Author: rsvite-architect -->

An adapter overrides the default only when a project needs additional work or a stronger observation, such as running an upstream test first, observing a stylesheet HMR frame, or waiting for framework stability. The runner passes the same declared edit handle to that override, requires an HMR-claiming override to apply it, and restores it on success, failure, or timeout. The edit handle rejects `apply()` after the update window closes or its abort signal fires. The adapter may restore early when restoration itself is part of the observation. The runner does not execute the default edit for non-HMR lifecycles or runs that do not claim HMR.
<!-- Author: rsvite-architect -->

Keeping these fields executable was chosen over making them optional: an optional action could again let the manifest describe an update different from the one an adapter performs. This ownership rule governs evidence mutation and cleanup only; it does not move project-specific browser signals, noise rules, or cold-phase records into the runner.
<!-- Author: rsvite-architect -->

- Run Vite and rsvite on the same runner image, exact project commit, lockfile, Node version, and browser version.
  <!-- Author: rsvite-lead -->
- Record correctness, the first incompatible behavior, supported API level, capability owner, and every explicit fallback before interpreting performance.
  <!-- Author: rsvite-lead -->
- HMR acceptance listens for main-frame navigation and checks an in-memory sentinel that is not stored in IndexedDB or localStorage. Persisted application state alone cannot distinguish HMR from a full reload.
  <!-- Author: rsvite-lead -->
- The first measurement run records raw time, memory, cold/warm cache conditions, run order, and variation. It then fixes the formal sample size, statistic, and non-double-counting memory measure before comparative claims begin.
  <!-- Author: rsvite-lead -->
- A development adapter that points a project at a local rsvite workspace proves behavior only. A package-replacement claim also requires installing a packed package in a clean checkout and validating its bin, exports, Node ABI, native binding, and declared platform matrix.
  <!-- Author: rsvite-lead -->

The initial reproducible evidence environment is Linux x64, Node `24.20.0`, and Chromium. It is not the final support matrix; a release declares and tests its supported operating systems, architectures, Node versions, and browsers.
<!-- Author: rsvite-lead -->
