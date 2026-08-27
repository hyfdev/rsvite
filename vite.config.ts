import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    overrides: [
      {
        files: ["**/*.md"],
        options: { proseWrap: "preserve" },
      },
    ],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "unicorn/prefer-node-protocol": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    tasks: {
      "check:format": {
        command: "vp fmt --check",
      },
      "check:lint": {
        command: "vp lint --deny-warnings",
      },
      "check:rust": {
        command: "cargo metadata --format-version 1 --no-deps",
      },
      "check:test:contract": {
        command: "vp test --config packages/compatibility-contract/vite.config.ts",
      },
      "check:test:runner": {
        command: "vp test --config packages/compatibility-runner/vite.config.ts",
      },
      ready: {
        command: "echo ready checks passed",
        dependsOn: [
          "check:format",
          "check:lint",
          "check:rust",
          "check:test:contract",
          "check:test:runner",
        ],
      },
    },
  },
});
