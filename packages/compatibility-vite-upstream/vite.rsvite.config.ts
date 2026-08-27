import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["packages/compatibility-vite-upstream/tests/rsvite-subject.test.mts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    retry: 0,
  },
});
