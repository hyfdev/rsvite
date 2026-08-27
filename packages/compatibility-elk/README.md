# @rsvite/compatibility-elk

The pinned ELK compatibility adapter. It checks out `elk-zone/elk` at
`ae4ebf3375eb68f1f355390b4f163adb10f5026c` into a disposable external directory, or reuses
`ELK_CHECKOUT` when that path is already the pin. ELK source and `nuxt.config.ts` stay outside
rsvite. Adapter code, the corpus entry, the preserved MIT license, and raw results live in this
repository.

`corpus/manifest.json` holds the durable `elk` real-project entry. Original commands are
`pnpm install --frozen-lockfile`, `pnpm dev:mocked`, `pnpm build`, and `pnpm start`. A run clones
that entry to bind a free port, set `CONTEXT=dev` so mocked mode still applies when `CI` is set,
set `NUXT_STORAGE_DRIVER=fs` so CI does not select Cloudflare KV, and point Chromium at `/home`.
Dev readiness is the process printing `Local:` — a one-second HTTP probe of `/home` cannot wait
out the first compile.

The Vite baseline covers mocked `dev`: Chromium reaches `/home`, sees the mocked `elkdev` account
and timeline, then waits until the page is observably stable (no further events for a bounded
quiet streak). Cold optimize-deps reloads and their 504 / aborted-module errors belong to that
cold phase; they are recorded under `extensions.x-elk.coldOptimizeDeps` and are not acceptance
errors. Acceptance then opens a fresh page against the now-warm Vite optimizer cache, navigates
Home → Explore → Home, and applies the shared in-memory sentinel and navigation rule to a real,
reverted find/replace in `app/styles/global.css`. `pnpm build` must finish client, SSR, PWA,
prerender, and Nitro packaging and produce `.output/public/elk-sw.js`, `.output/public/index.html`,
and `.output/server/index.mjs`. Preview serves `.output/server/index.mjs`. After every lifecycle,
`git status --porcelain` on the ELK checkout must stay empty.

The current rsvite run records the first missing package-replacement path as a C0 Rust-owned
compatibility failure. It never falls back to Vite.

Regenerating committed evidence from a clean pin checkout (no `node_modules`, or with
`node_modules/.cache/vite` removed so the recorder itself observes cold optimize-deps):

```sh
ELK_CHECKOUT=/path/to/elk RUNNER_IMAGE=ubuntu-24.04 pnpm exec vp run record:elk:baseline
```

The recorder installs with the lockfile pnpm `11.6.0`. That binary must already be in the
Corepack cache (`corepack install -g pnpm@11.6.0 --cache-only`); a host that has never cached
it fails with `corepack did not cache pnpm@11.6.0`. `ELK_CHECKOUT` and `RUNNER_IMAGE` are
declared on that task. Chromium is required for recording:

```sh
pnpm --filter @rsvite/compatibility-elk exec playwright install --with-deps chromium
```
