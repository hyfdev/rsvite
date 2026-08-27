# @rsvite/compatibility-runner

The shared process and browser orchestration behind every compatibility run. Vite and rsvite reach
a raw result through this one path, so a difference between two results is a difference between the
subjects rather than between two ways of measuring them.

```ts
import { runCompatibilityCheck } from "@rsvite/compatibility-runner";

const report = await runCompatibilityCheck({
  manifest,
  entryId: "drawdb",
  lifecycle: "dev",
  subject: { name: "rsvite", version: "0.0.0" },
  environment,
  projectRoot,
  artifactRoot,
  origin: "http://127.0.0.1:5173",
  declared,
  browser,
  timeouts: { installMs: 600_000, lifecycleMs: 300_000, browserMs: 30_000 },
});
```

One call runs install plus one selected lifecycle command for one entry under one subject, and
returns a raw result already accepted with its manifest by the contract's canonical
`validateResultAgainstManifest`. A result the contract would reject is never returned: the runner
throws instead, because an invalid document is worse than a missing run.

## What the runner decides, and what it refuses to

It decides everything observable: whether a command failed, timed out or never became ready,
what the browser reported, and whether an update was really a full reload.

It decides nothing about the product. Which capabilities a run set out to verify, which
implementation owns them, what fell back, and what a failure means all arrive through `declared`
and are recorded as given. The runner would have to infer them from command output, and an
inferred value in the evidence is worse than no run at all. If a run fails and the caller's
`classifyFailure` returns nothing, the runner throws rather than inventing a classification.

## Processes

Every command leads its own process group. A dev server started through a package manager is a
tree, and killing only the direct child orphans the rest — which then keeps the port the next run
needs. Stopping a command therefore signals the group, waits briefly, and escalates to `SIGKILL`.
A timeout is reported on the result rather than thrown, because a subject that hangs is evidence.

Readiness follows the manifest: an HTTP probe, a stdout pattern, or the process exiting. A command
that dies while being waited on is reported as having exited before readiness, so a crash is never
filed as a slow start.

Groups outlive their parent by design, which is what makes group cleanup work. A normal exit of the
host still kills any group left running; a host killed by an unhandled signal never runs exit
handlers at all, and installing signal handlers would change the semantics of whatever embeds this
runner, so that case stays with the embedder.

## Browser adapters

A `BrowserAdapter` opens a page, evaluates expressions in the _current_ document, and reports
events. It never returns a verdict. The runner normalizes console errors, page errors and failed
requests onto the result and applies the reload rule itself, so every subject is judged the same
way no matter which adapter drove it:

- any main-frame navigation during the update window is a full reload;
- an in-memory sentinel that did not survive the update is a full reload the navigation record
  happened to miss.

`createSyntheticBrowser` is an in-memory adapter for exercising orchestration without a browser. It
models the property the sentinel rule depends on: navigating installs a new document, and the new
document does not inherit the previous document's memory. A real browser adapter belongs to the
issue that consumes this runner.

## Fixtures

`fixtures/` holds a synthetic project — one HTTP server serving one document, and a script that
exits with a requested code after a requested delay. They exist to drive success, failure, timeout,
readiness, browser and cleanup paths. They are not a corpus entry and produce no compatibility
evidence about any project.
