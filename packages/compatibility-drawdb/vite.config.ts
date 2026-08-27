import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["packages/compatibility-drawdb/tests/**/*.test.mts"],
    retry: 0,
    testTimeout: 30_000,
  },
});
