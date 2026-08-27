import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { inspectCheckout } from "../src/index.ts";
import {
  assertPinnedTranslations,
  inspectTranslations,
  prepareTranslations,
} from "../src/translations.ts";
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

test("a file the translations repository ignores is still an undeclared build input", () => {
  const checkout = pinnedCheckout();
  const locale = join(checkout.root, checkout.pin.translations.path);
  // `source.json` is ignored by that repository, survives the project's own prune, and is
  // imported by the application along with every other JSON here.
  writeFileSync(join(locale, "source.json"), `{"welcome":"Something nobody declared"}\n`);

  // Nothing an ordinary status or the outer checkout can see.
  assert.deepEqual(inspectCheckout(checkout.root, checkout.pin), []);
  assert.equal(
    execFileSync("git", ["-C", locale, "status", "--porcelain"], { encoding: "utf8" }),
    "",
  );

  const problems = inspectTranslations(checkout.root, checkout.pin);
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.detail ?? "", /source\.json/);
});

test("preparing an existing checkout removes what the pinned tree does not contain", async () => {
  const checkout = pinnedCheckout();
  const locale = join(checkout.root, checkout.pin.translations.path);
  writeFileSync(join(locale, "source.json"), `{"welcome":"Something nobody declared"}\n`);
  writeFileSync(join(locale, "de.json"), `{"welcome":"Willkommen"}\n`);

  await prepareTranslations(checkout.root, checkout.pin);

  assert.equal(existsSync(join(locale, "source.json")), false, "the ignored file survived");
  assert.equal(existsSync(join(locale, "de.json")), false, "the untracked file survived");
  assert.deepEqual(inspectTranslations(checkout.root, checkout.pin), []);
});
