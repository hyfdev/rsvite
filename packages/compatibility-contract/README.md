# @rsvite/compatibility-contract

The versioned contract for every compatibility validation input and every raw result rsvite
measures. Runners and project adapters read and write these shapes instead of inventing a
project-specific format, so results from different inputs stay comparable.

- `schemas/corpus-manifest.v1.schema.json` — the corpus: what is validated, pinned to an exact
  source commit, with the commands, readiness signal and browser acceptance entry needed to run it.
- `schemas/raw-result.v1.schema.json` — one measured run of one corpus entry under one subject.
- `schemas/capability.v1.schema.json` — the product capability names, referenced by both of the
  above so a capability never has two spellings on the two sides of the contract.

## What is normative

The versioned JSON Schemas are the only normative definition of document _shape_, and this package
deliberately ships no static TypeScript shape for either document, so there is no second shape
definition that could disagree with them.

Shape is not the whole contract. Whether one entry id is reused, whether a result's commit matches
the entry it names, whether ownership contradicts a declared fallback, whether `finishedAt` follows
`startedAt` — none of these are expressible in JSON Schema, and all of them decide whether a
document is usable evidence. The canonical validator is the normative enforcement of both halves:
the schemas plus those cross-document and semantic invariants.

A consumer in another language therefore cannot produce valid evidence by validating against the
schemas alone; it has to implement or call the same versioned invariants.

```ts
import { createContractValidators } from "@rsvite/compatibility-contract";

const { validateResultAgainstManifest } = createContractValidators();

const check = validateResultAgainstManifest(manifest, result);
if (!check.valid) {
  throw new Error(check.violations.map((violation) => violation.message).join("\n"));
}
```

`validateResultAgainstManifest` is the canonical check and the one to reach for by default. Two
documents that are each well-formed can still be incoherent as evidence, so it validates both
shapes and then their relationship; the single-document `validateCorpusManifest` and
`validateRawResult` remain available for the moment a manifest is loaded or a result is written.

## What validation refuses to accept

The schemas encode the rules the compatibility record already commits to, so a malformed input
fails at load time rather than producing evidence that cannot be interpreted.

Within one document:

- A source pinned to a branch or tag instead of a full commit SHA, or vendored without its license.
- A manifest that reuses an entry id, which JSON Schema cannot express. Entry ids are the join key
  between a manifest and the results that reference it.
- A result without a correctness outcome, without ownership for the capabilities it measured, or
  without the JavaScript API level the run was measured at. `explicitFallbacks` is required too: an
  empty array asserts there were none.
- A failing result that does not name the first incompatible behavior and classify the failure —
  and, symmetrically, a passing result that still carries those failure-only fields.
- A result whose ownership contradicts its own fallbacks. Each fallback names the capabilities it
  carried, and a capability a fallback carried cannot also be reported as Rust-owned: whatever fell
  back was executed by Vite's JavaScript core.
- A baseline result filed as if it were rsvite. When the subject is `vite`, every owner must be
  `vite` and `explicitFallbacks` must be empty — the original implementation has nothing to fall
  back to.
- An HMR check whose sentinel is stored rather than held in memory, or that does not treat a
  main-frame navigation as a failure. Persisted state survives a reload and cannot prove an update.
- A measurement without its cache state and run order, which a comparison or a variation estimate
  cannot be built from.
- `finishedAt` earlier than `startedAt`, and a Node or package-manager version that is not a
  complete version string. Versions accept SemVer prerelease and build metadata and nothing else,
  so `24.20.0-rc.1+build.7` is valid while `24.20.0garbage` is not.

Between a manifest and a result:

- A result naming an entry the manifest does not contain, or restating a different source commit
  than that entry pins.
- A result claiming a higher API level than the entry declares. Lower is expected — a subject that
  only supports C0 measured against an entry declared at C1 records C0 — but a run cannot
  demonstrate an API surface the input never exercised.
- An environment whose package manager differs in name or version from the entry's lockfile. The
  same lockfile and package manager are what make two subjects comparable.
- Ownership or a fallback naming a capability the entry never declared.

## What one result does and does not claim

A raw result covers one command run. An entry's `expectedCapabilities` is the target scope of the
whole input, and a real project entry has several commands, so a result owns a subset of that
scope rather than all of it: a passing `dev` run has not exercised the entry's build or preview
capabilities, and demanding the full set would make it claim runs that never happened. Ownership
must be non-empty and free of duplicates, and every capability in it must be declared by the entry.

Whether an entry is covered as a whole is therefore a question across results, not a property of
any one of them, and it belongs to the runner and later aggregate validation.

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

`contractVersion` and the `v1` in each schema `$id` move together, and they cover the validator's
semantics as well as the schemas' shapes. A change that would reject a document the current version
accepts — a new required field, a new relational rule, a tightened invariant — publishes `v2`
alongside `v1` rather than editing `v1` in place, so already-recorded results stay readable.
Opening `v2` is not reserved for edits to the JSON Schema files.

## Examples

`examples/` holds documents that are accepted and documents that must be rejected, plus
manifest-and-result pairs for the relational rules. The tests in `tests/` validate every one of
them and assert the specific complaint each rejection must produce. They are fixtures for the
contract, not the adopted corpus — the corpus itself is assembled by the M0 issues.
