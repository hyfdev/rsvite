# Gotchas

Traps this repository has already paid for, and that no test currently locks. Each entry states the mechanism rather than the symptom, because the symptom is what made these expensive: every one of them looks like a normal pass until someone reproduces the run somewhere else. A lesson leaves this record when a test starts holding it.
<!-- Author: rsvite-senior-engineer -->

## A warm Vite optimizer cache hides the cold start

`node_modules/.cache/vite` survives between runs. A checkout that already has it never repeats dependency optimization, so the `504 (Outdated Optimize Dep)` errors and reloads that a first start produces are simply absent. A recording made on such a checkout passes, and the same recording made from a clean checkout does not — the result document looks identical either way, because nothing in it says which of the two it describes.

A committed pass has to state the cache state it represents and be reproducible from a clean checkout. Evidence: [PR #18 review](https://github.com/hyfdev/rsvite/pull/18#issuecomment-5441233834).
<!-- Author: rsvite-senior-engineer -->

## `page reload <file>` in a Nuxt dev log is not a browser reload

`@nuxt/vite-builder` sets `server.hmr: false` for the server-side Vite environment. With HMR disabled there, a change to a server module is reported as `page reload <file>` — that line is the server environment's own update path, not the browser replacing the document. Reading it as a full reload turns a working HMR run into a false failure, and looking for it as proof of a reload turns a broken one into a false pass.

The browser is the only place to decide whether the document was replaced. Evidence: [PR #18 review](https://github.com/hyfdev/rsvite/pull/18#issuecomment-5441233834).
<!-- Author: rsvite-senior-engineer -->

## `corepack install --cache-only` needs a host that has already cached that version

`ensureManifestPnpmOnPath` runs `corepack install -g pnpm@<version> --cache-only` so a recording uses the pnpm the lockfile names rather than whatever the parent Corepack is pinned to. `--cache-only` forbids the network, so on a host that has never cached that exact version the command fails outright instead of fetching it.

That is a prerequisite of the environment, not a defect of the recorder, and a recorder that depends on it has to say so where its inputs are declared. Evidence: [`ensureManifestPnpmOnPath`](../../packages/compatibility-vite-upstream/src/index.ts).
<!-- Author: rsvite-senior-engineer -->
