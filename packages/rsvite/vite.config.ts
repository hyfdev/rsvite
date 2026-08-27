import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mjs", "packages/rsvite/tests/**/*.test.mjs"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
