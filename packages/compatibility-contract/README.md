# @rsvite/compatibility-contract

The versioned contract for every compatibility validation input and every raw result rsvite
measures. Runners and project adapters read and write these shapes instead of inventing a
project-specific format, so results from different inputs stay comparable.

- `schemas/corpus-manifest.v1.schema.json` — the corpus: what is validated, pinned to an exact
  source commit, with the commands, readiness signal and browser acceptance entry needed to run it.
- `schemas/raw-result.v1.schema.json` — one measured run of one corpus entry under one subject.

## The schemas are the contract

The JSON Schema files are the only normative definition. Consumers validate at their boundary —
when a manifest is loaded and when a result is written — and this package deliberately ships no
static TypeScript shape for either document, so there is no second definition that could disagree
with the schemas.

```ts
import { createContractValidators } from "@rsvite/compatibility-contract";

const { validateCorpusManifest, validateRawResult } = createContractValidators();

const result = validateCorpusManifest(JSON.parse(await readFile(path, "utf8")));
if (!result.valid) {
  throw new Error(result.violations.map((violation) => violation.message).join("\n"));
}
```

Validation enforces formats and rejects unknown properties, and it additionally rejects a manifest
that reuses an entry id, which JSON Schema cannot express. Entry ids are the join key between a
manifest and the results that reference it.

## What validation refuses to accept

The schemas encode the rules the compatibility record already commits to, so a malformed input
fails at load time rather than producing evidence that cannot be interpreted:

- A source pinned to a branch or tag instead of a full commit SHA, or vendored without its license.
- A result without a correctness outcome, without the capability owner that a Rust-first claim
  depends on, or without the JavaScript API level the run was measured at. `explicitFallbacks` is
  required as well: an empty array asserts there were none.
- A result whose API level is inferred rather than recorded. The level belongs on the result, not
  only on the entry: one corpus entry produces a Vite baseline result and an rsvite result that can
  sit at different levels.
- A failing result that does not name the first incompatible behavior and classify the failure.
- An HMR check whose sentinel is stored rather than held in memory, or that does not treat a
  main-frame navigation as a failure. Persisted state survives a reload and cannot prove an update.
- A measurement without its cache state and run order, which a comparison or a variation estimate
  cannot be built from.

## Extending the contract from an adapter

A project-specific adapter puts its own data under `extensions`, keyed by a `x-`-prefixed
namespace it owns:

```json
{ "extensions": { "x-vite-upstream": { "suite": "playground/css", "mode": "serve" } } }
```

Core objects reject unknown properties, so an adapter cannot widen the shared shape by accident.
Adapter behavior lives outside any vendored upstream copy: the contract never asks an adapter to
edit upstream sources, fixtures or expectations.

## Versioning

`contractVersion` and the `v1` in each schema `$id` move together. A change that would reject a
document the current version accepts, or that adds a required field, publishes `v2` alongside `v1`
rather than editing `v1` in place, so already-recorded results stay readable.

## Examples

`examples/` holds documents that are accepted and documents that must be rejected; the tests in
`tests/` validate every one of them and assert where each rejection is reported. They are fixtures
for the contract, not the adopted corpus — the corpus itself is assembled by the M0 issues.
