import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const viteCheckout = process.env["RSVITE_VITE_CHECKOUT"];
const testRoot = viteCheckout ?? repositoryRoot;
const testSpec =
  viteCheckout === undefined
    ? "corpus/vite-upstream/playground/html/__tests__/html.spec.ts"
    : "playground/html/__tests__/html.spec.ts";
const extraSetup = process.env["RSVITE_EXTRA_TEST_SETUP"];

export default {
  resolve: {
    alias: {
      "~utils": resolve(packageRoot, "tests/upstream-utils.mjs"),
    },
  },
  test: {
    root: testRoot,
    include: [testSpec],
    reporters: ["default", "json"],
    ...(extraSetup === undefined ? {} : { setupFiles: [extraSetup] }),
    testNamePattern: /^main preserve comments$/,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
};
