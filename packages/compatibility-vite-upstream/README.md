# @rsvite/compatibility-vite-upstream

The pinned Vite upstream HTML E2E slice. The vendored files under `corpus/vite-upstream/` are
byte-identical copies of Vite at `ee644014aab61e546742b862a7d7b0d6c7d67a7b`. This package records
that pin, rejects unrecorded edits, and exports the adapter entry Issue #10 uses to run
`main > preserve comments` against rsvite without changing the imported spec.

- `corpus/vite-upstream/` — `LICENSE`, `playground/html/__tests__/html.spec.ts`, and
  `playground/html/index.html`.
- `provenance.json` — source path, dest path, and SHA-256 of each imported file. A dest that
  differs from that digest needs an exception with the current digest and a reason.
- `corpus/manifest.json` — the versioned `vite-upstream-e2e` entry. Its `x-vite-upstream`
  extension names the selected case; it does not edit the vendored files.

`htmlPreserveCommentsAdapter` is the external adapter entry. This package does not run the
imported case or write a Vite baseline result.
