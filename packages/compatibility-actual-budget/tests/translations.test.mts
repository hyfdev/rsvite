import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { inspectCheckout } from "../src/index.ts";
import { assertPinnedTranslations, inspectTranslations } from "../src/translations.ts";
import { pinnedCheckout } from "./support.mts";

test("a translations checkout at another revision is not the pinned input", () => {
  const checkout = pinnedCheckout();
  const locale = join(checkout.root, checkout.pin.translations.path);
  writeFileSync(join(locale, "en.json"), `{"welcome":"Moved on"}\n`);
  execFileSync("git", ["-C", locale, "commit", "--quiet", "--all", "--message", "advance"]);

  assert.throws(
    () => {
      assertPinnedTranslations(checkout.root, checkout.pin);
    },
    /but the corpus pins/,
    "the build would have read a revision nobody recorded",
  );
});

test("a translations checkout the build pruned is not the pinned input", () => {
  const checkout = pinnedCheckout();
  // What `remove-untranslated-languages` does to it.
  rmSync(join(checkout.root, checkout.pin.translations.path, "en.json"));

  const problems = inspectTranslations(checkout.root, checkout.pin);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.kind, "modified");
});

test("a missing translations checkout is refused, not silently cloned by the build", () => {
  const checkout = pinnedCheckout();
  rmSync(join(checkout.root, checkout.pin.translations.path), { recursive: true });

  const problems = inspectTranslations(checkout.root, checkout.pin);
  assert.equal(problems[0]?.kind, "missing");
  assert.match(problems[0]?.detail ?? "", /would clone a moving one/);
});

test("the outer checkout reads clean while the input the build compiles has moved", () => {
  const checkout = pinnedCheckout();
  const locale = join(checkout.root, checkout.pin.translations.path);
  writeFileSync(join(locale, "en.json"), `{"welcome":"Moved on"}\n`);
  execFileSync("git", ["-C", locale, "commit", "--quiet", "--all", "--message", "advance"]);

  // This is the whole point: the project ignores that directory, so the outer status cannot see
  // it, and a recording that only checks the outer checkout reports a reproducible run that isn't.
  assert.deepEqual(inspectCheckout(checkout.root, checkout.pin), []);
  assert.equal(inspectTranslations(checkout.root, checkout.pin).length, 1);
});
