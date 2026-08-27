import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["html-filter-probe.spec.ts"],
  },
});
