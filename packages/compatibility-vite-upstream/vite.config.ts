import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mts", "packages/compatibility-vite-upstream/tests/**/*.test.mts"],
    exclude: ["packages/compatibility-vite-upstream/tests/rsvite-subject.test.mts"],
    retry: 0,
  },
});
