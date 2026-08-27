import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mts", "packages/compatibility-contract/tests/**/*.test.mts"],
    retry: 0,
  },
});
