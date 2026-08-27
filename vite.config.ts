import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["corpus/vite-upstream"],
    overrides: [
      {
        files: ["**/*.md"],
        options: { proseWrap: "preserve" },
      },
    ],
  },
  lint: {
    ignorePatterns: ["corpus/vite-upstream"],
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
      "check:test:vite-upstream": {
        command: "vp test --config packages/compatibility-vite-upstream/vite.config.ts",
      },
      ready: {
        command: "echo ready checks passed",
        dependsOn: [
          "check:format",
          "check:lint",
          "check:rust",
          "check:test:contract",
          "check:test:runner",
          "check:test:vite-upstream",
        ],
      },
    },
  },
});
