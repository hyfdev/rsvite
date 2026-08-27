# @rsvite/compatibility-actual-budget

The pinned Actual Budget gate. `pin.json` names the commit, license, lockfile and package manager
this corpus entry is measured at, plus the project's own onboarding spec, development port and the
single source edit an update is observed through. Nothing in the checkout is modified: the project
provides its own commands, its own Playwright and its own acceptance, and this package drives them.

- `src/index.ts` — the pin, the checkout inspection, the corpus entry generated from the pin, and
  the commands each subject is driven by.
- `src/browser.ts` — the `BrowserAdapter` built on the checkout's own Playwright, including the
  arrival wait that keeps the application's startup routing out of the update window.
- `src/upstream.ts` — the project's own commands, run under a budget the caller can also end.
- `src/record.ts` — one subject, recorded and published only if the recording itself held.

`corpus/results/actual-budget/vite/` is the original Vite baseline. `corpus/results/actual-budget/rsvite/`
is what rsvite currently does with the same input. `vp run ready` re-validates both against the
corpus manifest.

## Recording

```sh
ACTUAL_BUDGET_CHECKOUT=/path/to/actual RUNNER_IMAGE=ubuntu-24.04 \
  pnpm exec vp run record:actual-budget:baseline
```

`ACTUAL_BUDGET_CHECKOUT`, `RUNNER_IMAGE` and the optional `RECORD_SUBJECTS` (`both` by default,
or `vite` / `rsvite`) are declared on that task so Vite+ forwards them. There is no default for the
first two: a result that does not say which checkout and which image produced it is not comparable
with another one.

The checkout must be at the pinned commit with no staged, unstaged or untracked changes. That is
checked before the run and **again after every upstream command has finished**, because the
project's own spec and build run arbitrary code in it — undoing the one edit this adapter makes
proves nothing about what else was left behind.

The browser is a declared input too. The recorder launches the checkout's own Chromium and records
`browser.version()`, which is the browser that actually ran rather than the version of the
Playwright library that launched it. If no browser is installed, it runs the project's own
`playwright install chromium` once and reports clearly if that still leaves nothing to launch.

Order matters and is enforced rather than documented: the project's own production build runs
**before** any result exists, and the result is written into a staging directory that is published
only after the build passed, the run finished and the checkout was verified again. A build that
fails, a spec that hangs past its budget, or a checkout the run dirtied therefore cannot leave
evidence behind that reads as a pass. `tests/record.test.mts` and `tests/upstream.test.mts` hold
those paths.

The build and the spec write `upstream-build.*` and `upstream-e2e.*` beside the result. The
result's own `artifactPaths` name what the runner produced; those two pairs are what the recorder
produced around it, and they are published together so the run can be read end to end.

## What each subject records

The Vite baseline runs the project's own development server, then its own onboarding spec against
that server, then one source edit that the server is expected to patch into the running document.

The rsvite result runs the same input through rsvite's Vite-compatible entry point, which is what
a drop-in replacement has to be able to do. It currently fails at the first lifecycle step, and
that failure is the recorded evidence: the result declares no capability owners, because a run
that cannot start has demonstrated none.
