# @rsvite/compatibility-elk

The pinned ELK compatibility adapter. It checks out `elk-zone/elk` at
`ae4ebf3375eb68f1f355390b4f163adb10f5026c` into a disposable external directory, or reuses
`ELK_CHECKOUT` when that path is already the pin. ELK source and `nuxt.config.ts` stay outside
rsvite. Adapter code, the corpus entry, the preserved MIT license, and raw results live in this
repository.

`corpus/manifest.json` holds the durable `elk` real-project entry. Original commands are
`pnpm install --frozen-lockfile`, `pnpm dev:mocked`, `pnpm build`, and `pnpm start`. A run clones
that entry to bind a free port, set `CONTEXT=dev` so mocked mode still applies when `CI` is set,
and point Chromium at `/home`.

The Vite baseline covers mocked `dev`: Chromium reaches `/home`, sees the mocked `elkdev` account
and timeline, navigates Home → Explore → Home, waits out cold optimize-deps reloads, then applies
the shared in-memory sentinel and navigation rule to a metadata-only `app/styles/global.css`
touch. `pnpm build` must finish client, SSR, PWA, prerender, and Nitro packaging. Preview serves
`.output/server/index.mjs`. After every lifecycle, `git status --porcelain` on the ELK checkout
must stay empty.

The current rsvite run records the first missing package-replacement path as a C0 Rust-owned
compatibility failure. It never falls back to Vite.

Regenerating committed evidence:

```sh
ELK_CHECKOUT=/path/to/elk RUNNER_IMAGE=ubuntu-24.04 pnpm exec vp run record:elk:baseline
```

`ELK_CHECKOUT` and `RUNNER_IMAGE` are declared on that task. Chromium is required for recording:

```sh
pnpm --filter @rsvite/compatibility-elk exec playwright install --with-deps chromium
```
