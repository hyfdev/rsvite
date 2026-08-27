# @rsvite/compatibility-drawdb

The pinned DrawDB compatibility adapter. The explicit `record:drawdb:baseline` task checks out `drawdb-io/drawdb` at `031aef1f1c1d3f9027ccfacbf084e9c1a31b8abc` into a disposable external directory, runs its original npm lifecycle with the repository-locked npm `11.19.0` executable, and writes raw results through the shared compatibility runner and contract.

`corpus/manifest.json` holds the durable `drawdb` real-project entry. The committed Vite dev, build, and preview baseline results and the first rsvite dev failure are under `corpus/results/drawdb/`; this package revalidates their contract fields, commands, and referenced logs.

The Vite baseline covers the editor at `/editor`, one local Add table interaction, a temporary `src/index.css` custom-property insertion and restoration observed through the shared in-memory-sentinel and navigation rule, build, and preview. After every lifecycle the adapter requires `git status --porcelain` to remain empty. The checkout is removed after the run.

Daily tests validate committed evidence, adapter logic, and a deterministic HMR browser seam. They do not clone DrawDB, install its dependencies, or launch Chromium:

```sh
pnpm exec vp test --config packages/compatibility-drawdb/vite.config.ts
```

Chromium is required only when recording fresh evidence. Install it and run:

```sh
pnpm --filter @rsvite/compatibility-drawdb exec playwright install --with-deps chromium
pnpm exec vp run record:drawdb:baseline
```

The committed rsvite/dev result records the current missing Node CLI entry before DrawDB can start. It uses C0 with the selected Rust-owned scope and no Vite fallback.
