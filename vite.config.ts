import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["corpus/vite-upstream", "packages/compatibility-vite-upstream/tests/fixtures"],
    overrides: [
      {
        files: ["**/*.md"],
        options: { proseWrap: "preserve" },
      },
    ],
  },
  lint: {
    ignorePatterns: ["corpus/vite-upstream", "packages/compatibility-vite-upstream/tests/fixtures"],
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
        command: "cargo clippy --workspace --all-targets --locked -- -D warnings",
      },
      "check:rust:format": {
        command: "cargo fmt --all -- --check",
      },
      "build:rsvite:native": {
        command:
          "vp exec --filter rsvite -- napi build --manifest-path ../../crates/rsvite_binding/Cargo.toml --package-json-path package.json --output-dir . --platform --js native.js --dts native.d.ts --esm --release -- --locked",
      },
      "check:test:rsvite:core": {
        command: "cargo test -p rsvite_core --locked",
      },
      "check:test:rsvite:package": {
        command: "vp test --config packages/rsvite/vite.config.ts",
        dependsOn: ["build:rsvite:native"],
      },
      "check:test:rsvite:upstream": {
        command: "vp test --config packages/compatibility-vite-upstream/vite.rsvite.config.ts",
        dependsOn: ["build:rsvite:native"],
      },
      "check:test:contract": {
        command: "vp test --config packages/compatibility-contract/vite.config.ts",
      },
      "check:test:runner": {
        command: "vp test --config packages/compatibility-runner/vite.config.ts",
      },
      "check:test:rsvite-workspace": {
        command: "vp test --config packages/compatibility-rsvite-workspace/vite.config.ts",
      },
      "check:test:vite-upstream": {
        command: "vp test --config packages/compatibility-vite-upstream/vite.config.ts",
      },
      "check:test:actual-budget": {
        command: "vp test --config packages/compatibility-actual-budget/vite.config.ts",
      },
      "check:test:elk": {
        command: "vp test --config packages/compatibility-elk/vite.config.ts",
      },
      "check:test:drawdb": {
        command: "vp test --config packages/compatibility-drawdb/vite.config.ts",
      },
      "record:vite-upstream:baseline": {
        command:
          "node --experimental-strip-types packages/compatibility-vite-upstream/scripts/record-vite-baseline.mts",
        env: ["VITE_CHECKOUT", "RUNNER_IMAGE"],
      },
      "record:actual-budget:baseline": {
        command:
          "node --experimental-strip-types packages/compatibility-actual-budget/scripts/record-actual-budget-baseline.mts",
        env: ["ACTUAL_BUDGET_CHECKOUT", "RUNNER_IMAGE", "RECORD_SUBJECTS"],
      },
      "record:elk:baseline": {
        command:
          "node --experimental-strip-types packages/compatibility-elk/scripts/record-elk-baseline.mts",
        env: ["ELK_CHECKOUT", "RUNNER_IMAGE"],
      },
      "record:drawdb:baseline": {
        command:
          "node --experimental-strip-types packages/compatibility-drawdb/scripts/record-drawdb-baseline.mts",
        env: ["RUNNER_IMAGE"],
      },
      "record:rsvite-upstream:baseline": {
        command:
          "node --experimental-strip-types packages/compatibility-vite-upstream/scripts/record-rsvite-pair.mts",
        cache: false,
      },
      "test:m1:html": {
        command: "echo M1 HTML checks passed",
        dependsOn: [
          "check:test:rsvite:core",
          "check:test:rsvite:package",
          "check:test:rsvite:upstream",
          "check:test:rsvite-workspace",
          "check:test:vite-upstream",
        ],
      },
      ready: {
        command: "echo ready checks passed",
        dependsOn: [
          "check:format",
          "check:lint",
          "check:rust",
          "check:rust:format",
          "check:test:contract",
          "check:test:runner",
          "check:test:vite-upstream",
          "check:test:actual-budget",
          "check:test:elk",
          "check:test:drawdb",
          "test:m1:html",
        ],
      },
    },
  },
});
