# @rsvite/compatibility-vite-upstream

The pinned Vite upstream HTML E2E slice. The vendored files under `corpus/vite-upstream/` are
byte-identical copies of Vite at `ee644014aab61e546742b862a7d7b0d6c7d67a7b`. This package records
that pin, rejects unrecorded edits, and reads the selected-case adapter entry from the corpus
manifest.

- `corpus/vite-upstream/` — `LICENSE`, `playground/html/__tests__/html.spec.ts`, and
  `playground/html/index.html`.
- `provenance.json` — source path, dest path, and SHA-256 of each imported file. A dest that
  differs from that digest needs an exception with the current digest and a reason.
- `corpus/manifest.json` — the versioned `vite-upstream-e2e` entry. The `x-vite-upstream`
  extension names the selected spec, imported root, and `main > preserve comments` test.

`htmlPreserveCommentsAdapter` is that extension, read from the manifest. Paths are relative to
`corpus/vite-upstream/`.

The original Vite baseline for this entry is `corpus/results/vite-upstream-html-preserve-comments/vite/`,
produced by `runCompatibilityCheck` against a clean checkout of the pinned commit. `vp run ready`
re-validates that result with the corpus manifest. Regenerating it:

```sh
VITE_CHECKOUT=/path/to/vite RUNNER_IMAGE=ubuntu-24.04 pnpm exec vp run record:vite-upstream:baseline
```

`VITE_CHECKOUT` and `RUNNER_IMAGE` are declared on that task so Vite+ forwards them. The checkout
must be the pinned commit with no staged, unstaged, or untracked changes before and after the run.
The recorder reads `process.platform` and `process.arch`. It puts the lockfile pnpm (`10.34.5`)
first on PATH and checks `--version` in the Vite checkout, which is the command cwd. A host other
than Linux x64, or a pnpm other than `10.34.5`, is rejected before the run.
