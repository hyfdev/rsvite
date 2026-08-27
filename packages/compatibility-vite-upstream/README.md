# @rsvite/compatibility-vite-upstream

The pinned Vite upstream HTML E2E slice. The vendored files under `corpus/vite-upstream/` are
byte-identical copies of Vite at `ee644014aab61e546742b862a7d7b0d6c7d67a7b`. This package records
that pin, rejects unrecorded edits, and reads the selected-case adapter entry from the corpus
manifest.

- `corpus/vite-upstream/` — `LICENSE`, `playground/html/__tests__/html.spec.ts`,
  `playground/html/index.html`, and `playground/html/vite.config.js`.
- `provenance.json` — source path, dest path, and SHA-256 of each imported file. A dest that
  differs from that digest needs an exception with the current digest and a reason.
- `corpus/manifest.json` — the versioned `vite-upstream-e2e` entry. The `x-vite-upstream`
  extension names the selected spec, imported root, and `main > preserve comments` test.

`htmlPreserveCommentsAdapter` is that extension, read from the manifest. Paths are relative to
`corpus/vite-upstream/`. The selected case is C2: Vite loads `vite.config.js`, whose
`transformIndexHtml` hook wraps the source fragment in a body before the assertion.

The paired results are under `corpus/results/vite-upstream-html-preserve-comments/`. Vite records
C2 and passes. rsvite records C0, Rust-owned HTML with no fallback, and fails the unchanged test
because C0 ignores the project's configuration and Plugin API. Regenerate both results with:

```sh
VITE_CHECKOUT=/path/to/vite RUNNER_IMAGE=ubuntu-24.04 pnpm exec vp run record:rsvite-upstream:baseline
```

The paired task first validates the committed `packages/rsvite` name, version, and product source,
then builds the local native binding and records Vite before rsvite. A failed workspace preflight
does not start the build or replace either result. Both executions use the same external root,
lockfile pnpm (`10.34.5`), Node process, runner image, and the pinned checkout's Vitest `4.1.11`
assertion runner and `playwright-chromium@1.62.1` browser. `VITE_CHECKOUT` must be the pinned commit
with no staged, unstaged, or untracked changes before and after the run. A host other than Linux
x64, a pnpm other than `10.34.5`, or a different Vitest installation is rejected before recording.

Playground `test-serve` loads `packages/vite/dist/node/index.js`, which is gitignored and is not
produced by install. The recorder runs the lockfile install, deletes `packages/vite/dist`, then
`pnpm --filter vite build`, so a brand-new worktree of the pin repeats without a leftover bundle.

`vp run ready` validates the imported-file provenance and both committed results, then runs the
unchanged selected test against the local rsvite build and vendored input. It does not clone,
install, or record an external checkout. The recorder, committed-result check, and live daily probe
share one whole-execution validator: the negative result is accepted only when the selected
assertion is the complete failure. A green daily check preserves the Vite-pass/rsvite-fail
comparison; it does not claim that the C0 rsvite slice supports the C2 case.

The selected upstream test owns its Playwright browser inside the Vitest process. Contract v1
records an empty runner `browserErrors` array because no events cross the runner adapter boundary.
Both results record the nested browser separately as
`extensions.x-vite-upstream.browserObservation` =
`nested-vitest-browser-not-observed-by-runner`, and the package gate requires both fields.
