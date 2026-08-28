import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mts", "packages/compatibility-rsvite-workspace/tests/**/*.test.mts"],
    retry: 0,
    testTimeout: 30_000,
  },
});
