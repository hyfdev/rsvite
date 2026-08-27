# @rsvite/compatibility-actual-budget

The pinned Actual Budget gate. `pin.json` names everything the corpus holds fixed: the project's
commit, license, lockfile and package manager, the translations revision its production build
compiles in, its own onboarding spec, the development port, and the single source edit an update
is observed through. The project provides its own commands, its own Playwright and its own
acceptance; this package drives them.

- `src/index.ts` — the pin, the checkout inspection, the corpus entry generated from the pin, and
  the commands and readiness each run is driven by.
- `src/translations.ts` — the second input the build reads, which lives inside the checkout but
  outside its git history.
- `src/browser.ts` — the `BrowserAdapter` built on the checkout's own Playwright, including the
  arrival wait that keeps the application's startup routing out of the update window.
- `src/upstream.ts` — the project's own commands, run under a budget the caller can also end.
- `src/record.ts` — one run, published only if the recording itself held.

## What the checkout guarantee actually is

The project's source and tests are restored: the recorder makes one edit, to the file `pin.json`
names, and puts it back. It does not make a stronger claim than that. The production build runs
arbitrary upstream code — it prunes languages, writes bundles, and touches an ignored checkout —
so the guarantee that survives is narrower and is checked rather than asserted: **every fixed
input is verified before the run and again after everything has finished**, and a recording whose
inputs are no longer the pinned ones publishes nothing.

That verification covers the translations checkout too. Actual Budget's `bin/package-browser`
clones `actualbudget/translations` into `packages/desktop-client/locale`, pulls it, and deletes
the languages it does not ship. The directory is ignored by the project's own `.gitignore`, so an
ordinary status of the outer checkout cannot see it — while the application compiles its JSON into
the bundle. Without pinning it, the recorded commit and lockfile do not determine what was built.
The recorder therefore parks the pinned revision on a branch whose upstream is that same
repository, which leaves the project's own `git pull` a no-op: the upstream command runs exactly
as written and cannot change what it reads.

Ignored files inside that checkout count as well. The translations repository ignores
`source.json`, the application imports every `locale/*.json`, and the project's prune leaves
ignored files alone — so a file git is told not to mention is still compiled into the bundle.
Preparing the checkout clears them, and inspecting it reports anything the pinned tree does not
contain, ignored or not.

## Recording

```sh
ACTUAL_BUDGET_CHECKOUT=/path/to/actual RUNNER_IMAGE=ubuntu-24.04 \
  pnpm exec vp run record:actual-budget:baseline
```

`ACTUAL_BUDGET_CHECKOUT`, `RUNNER_IMAGE` and the optional `RECORD_SUBJECTS` (`both` by default, or
`vite` / `rsvite`) are declared on that task so Vite+ forwards them. There is no default for the
first two: a result that does not say which checkout and which image produced it is not comparable
with another one.

The browser is a declared input too. The recorder launches the checkout's own Chromium and records
`browser.version()`, which is the browser that actually ran rather than the version of the
Playwright library that launched it. If no browser is installed, it runs the project's own
`playwright install chromium` once and reports clearly if that still leaves nothing to launch.

Each run writes into a staging directory and is published only after it finished and every fixed
input was verified again, so a hung command or a checkout the run dirtied cannot leave behind
evidence that reads as a pass. `tests/record.test.mts`, `tests/upstream.test.mts` and
`tests/translations.test.mts` hold those paths.

## What is recorded

One result describes one lifecycle command, and the entry's coverage is what the results establish
together — so each lifecycle is recorded separately and claims only what it is in a position to
show.

- `corpus/results/actual-budget/vite/dev/` — the project's own development server, its own
  onboarding spec against that server, and one source edit the server patches into the running
  document. Owns `html`, `modules-and-assets`, `resolution`, `file-watching` and
  `hmr-without-full-reload`. The spec's own output is committed beside it as `upstream-e2e.*`;
  the runner does not name it in `artifactPaths` because the recorder rather than the runner
  produced it, so `tests/results.test.mts` requires it directly.
- `corpus/results/actual-budget/vite/build/` — the project's own production build. Owns
  `build-output`.
- `corpus/results/actual-budget/rsvite/dev/` — the same input driven by rsvite's Vite-compatible
  entry point, which is what a drop-in replacement has to be able to do. It currently fails at the
  first lifecycle step, and that failure is the recorded evidence. It declares `html` to `rust`:
  the one thing the first step needed, and the only thing a run that never started was in a
  position to be about.

`vp run ready` re-validates every committed result against the corpus manifest, checks that the
entry still matches the pin it is generated from, and fails if any evidence a result names — or
the recorder's own build and onboarding logs — is missing.

A known limitation: the committed entry records the readiness of the lifecycle that serves, and a
run for a lifecycle that finishes instead names its own. Expressing readiness per lifecycle in the
corpus contract would remove that asymmetry and is worth doing once more than one entry needs it.
