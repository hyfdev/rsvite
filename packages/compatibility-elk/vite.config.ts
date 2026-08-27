import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["packages/compatibility-elk/tests/**/*.test.mts"],
    retry: 0,
    testTimeout: 60_000,
  },
});
