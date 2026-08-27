# Intent

rsvite is a Rust implementation of Vite for existing Vite projects. Users always start rsvite through Node.js and npm, and Node enters the Rust core through `napi-rs`.
<!-- Author: rsvite-lead -->

## Product promise

- The ideal migration changes only the package or command. Project source, Vite configuration, and existing behavioral tests remain unchanged.
  <!-- Author: rsvite-lead -->
- Compatibility grows in [declared stages](compatibility.md#javascript-api-levels). Each release states which product capabilities, JavaScript APIs, Vite upstream tests, and real projects pass instead of claiming blanket Vite compatibility.
  <!-- Author: rsvite-lead -->
- Rust owns substantive execution and project state. JavaScript executes only user configuration, plugins, runtime modules, and programmatic calls required by the declared compatibility level.
  <!-- Author: rsvite-lead -->
- Correctness is established before performance results are used to claim an advantage over Vite.
  <!-- Author: rsvite-lead -->

## Benefit hypothesis

Moving dev and build state and scheduling into Rust should produce a repeatable improvement in startup time, HMR latency, or memory for at least one real workload while preserving that workload's required compatibility. A result does not support this hypothesis if it depends on moving Vite's core execution back into JavaScript.
<!-- Author: rsvite-lead -->

The first end-to-end path that passes the same correctness checks under Vite and rsvite becomes the first benefit decision point. Initial measurements establish run-to-run variation before the project fixes a target metric and threshold. If no result exceeds that variation, the project does not claim a performance benefit and re-examines the optimization target or the Rust/JavaScript boundary.
<!-- Author: rsvite-lead -->

## Compatibility direction

Broad Vite compatibility is the long-term direction, but compatibility count alone does not set priority. The [compatibility record](compatibility.md) defines the current evidence and levels. An API moves earlier when it blocks more real projects or upstream tests, belongs to Vite's current direction, preserves Rust execution ownership, and has a justified implementation and maintenance burden. An obsolete, low-value API may remain low priority without being declared permanently unsupported.
<!-- Author: rsvite-lead -->

## Non-goals

- A direct Rust CLI is not a user-facing alternative to the Node.js/npm entry. Rust-only invocation may exist for internal tests.
  <!-- Author: rsvite-lead -->
- The project does not promise complete Vite API compatibility by a fixed date.
  <!-- Author: rsvite-lead -->
- Performance does not excuse a correctness failure or an undeclared fallback to Vite's JavaScript core.
  <!-- Author: rsvite-lead -->
- Milestone order is not permanent. Validation and implementation evidence may change it.
  <!-- Author: rsvite-lead -->

## Reference project

[OJ](https://github.com/raphamorim/oj) demonstrates that a Rust core with JavaScript compatibility processes can run real applications. It is evidence and a comparison point, not an architecture specification or a compatibility claim for rsvite.
<!-- Author: rsvite-lead -->
