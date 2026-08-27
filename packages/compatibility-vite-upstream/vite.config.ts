import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mts", "packages/compatibility-vite-upstream/tests/**/*.test.mts"],
    retry: 0,
  },
});
