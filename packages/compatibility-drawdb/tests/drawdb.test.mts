import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContractValidators } from "@rsvite/compatibility-contract";
import {
  runCommand,
  type BrowserEvent,
  type BrowserPage,
  type HmrUpdate,
} from "@rsvite/compatibility-runner";
import { test } from "vite-plus/test";
import {
  DRAWDB_HMR_STYLESHEET_PATH,
  DRAWDB_HMR_UPDATE_COUNTER,
  isDrawDbStylesheetUpdate,
} from "../src/chromium.ts";
import { updateDrawDbStylesheet } from "../src/drawdb.ts";
import { drawDbHmrEdit, rsviteWorkspaceVersion } from "../src/manifest.ts";
import {
  assertDrawDbResultArtifactsExist,
  createDrawDbManifest,
  declaredDrawDbRun,
  DRAWDB_COMMIT,
  DRAWDB_ENTRY_ID,
  DRAWDB_LICENSE_PATH,
  DRAWDB_LOCKFILE,
  DRAWDB_REPOSITORY,
  drawDbEntryFromManifest,
  drawDbEvidenceResultPaths,
  readCorpusManifest,
  type DrawDbManifestOptions,
  type DrawDbRun,
} from "../src/index.ts";

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function readResult(path: string): Record<string, unknown> {
  return asRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function portFromResult(result: Record<string, unknown>): number {
  const argv = asRecord(result["command"])["argv"];
  assert.ok(Array.isArray(argv));
  const portFlag = argv.indexOf("--port");
  return portFlag === -1 ? 5173 : Number(argv[portFlag + 1]);
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  for (const [key, item] of Object.entries(record)) {
    assert.equal(typeof item, "string", `${key} must be a string`);
  }
  return record as Record<string, string>;
}

test("the committed DrawDB entry pins the source, original lockfile, and Vite lifecycle", () => {
  const corpusManifest = readCorpusManifest();
  const corpusCheck = createContractValidators().validateCorpusManifest(corpusManifest);
  assert.equal(corpusCheck.valid, true, corpusCheck.valid ? "" : JSON.stringify(corpusCheck));

  const committed = drawDbEntryFromManifest(corpusManifest);
  assert.equal(committed["id"], DRAWDB_ENTRY_ID);
  assert.equal(committed["kind"], "real-project");
  assert.equal(asRecord(committed["source"])["repository"], DRAWDB_REPOSITORY);
  assert.equal(asRecord(committed["source"])["commit"], DRAWDB_COMMIT);
  assert.equal(asRecord(asRecord(committed["source"])["license"])["path"], DRAWDB_LICENSE_PATH);
  assert.equal(asRecord(committed["lockfile"])["path"], DRAWDB_LOCKFILE);
  assert.deepEqual(asRecord(asRecord(committed["lockfile"])["packageManager"]), {
    name: "npm",
    version: "11.19.0",
  });
  assert.deepEqual(asRecord(committed["commands"])["build"], {
    argv: ["npm", "run", "build"],
  });
  assert.deepEqual(drawDbHmrEdit(corpusManifest), {
    path: "src/index.css",
    find: '@import "tailwindcss";',
    replace: '@import "tailwindcss";\n:root { --rsvite-drawdb-hmr-probe: active; }',
  });

  const manifest = createDrawDbManifest({
    lifecycle: "dev",
    port: 5173,
    subject: "vite",
  });
  const check = createContractValidators().validateCorpusManifest(manifest);
  assert.equal(check.valid, true, check.valid ? "" : JSON.stringify(check.violations));

  const entry = drawDbEntryFromManifest(manifest);
  assert.equal(entry["id"], DRAWDB_ENTRY_ID);
  assert.equal((entry["source"] as { commit: string }).commit, DRAWDB_COMMIT);
  assert.equal((entry["lockfile"] as { path: string }).path, "package-lock.json");
  assert.deepEqual(asRecord(asRecord(entry["lockfile"])["packageManager"]), {
    name: "npm",
    version: "11.19.0",
  });
  assert.deepEqual((entry["commands"] as { dev: { argv: string[] } }).dev.argv.slice(0, 3), [
    "npm",
    "run",
    "dev",
  ]);
});

test("rsvite records the DrawDB C0 scope with Rust ownership and no Vite fallback", () => {
  const declared = declaredDrawDbRun({ subject: "rsvite", lifecycle: "dev" });
  assert.equal(rsviteWorkspaceVersion(), "0.0.0");
  assert.equal(declared.javascriptApiLevel, "C0");
  assert.equal(declared.explicitFallbacks.length, 0);
  assert.ok(declared.capabilityOwners.every((owner) => owner.owner === "rust"));

  const manifest = createDrawDbManifest({
    lifecycle: "dev",
    port: 5173,
    subject: "rsvite",
  });
  const command = asRecord(asRecord(drawDbEntryFromManifest(manifest)["commands"])["dev"])["argv"];
  assert.ok(Array.isArray(command));
  assert.deepEqual(command, ["rsvite", ".", "--port", "5173"]);
});

test("DrawDB declarations reject rsvite build and preview evidence", () => {
  for (const lifecycle of ["build", "preview"] as const) {
    const invalidManifestOptions = {
      lifecycle,
      port: 5173,
      subject: "rsvite",
    } as unknown as DrawDbManifestOptions;
    const invalidRun = {
      lifecycle,
      subject: "rsvite",
    } as unknown as DrawDbRun;

    assert.throws(
      () => createDrawDbManifest(invalidManifestOptions),
      new RegExp(`DrawDB does not support rsvite ${lifecycle}`),
    );
    assert.throws(
      () => declaredDrawDbRun(invalidRun),
      new RegExp(`DrawDB does not support rsvite ${lifecycle}`),
    );
  }
});

test("the runtime DrawDB manifest resolves the repository-locked npm version", async () => {
  const manifest = createDrawDbManifest({ lifecycle: "build", port: 5173, subject: "vite" });
  const command = asRecord(asRecord(drawDbEntryFromManifest(manifest)["commands"])["build"]);
  const environment = asStringRecord(command["env"]);
  const outcome = await runCommand({ argv: ["npm", "--version"], env: environment }, 30_000);

  assert.equal(outcome.startError, undefined);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.stdout.trim(), "11.19.0");
});

const committedEvidence = [
  {
    path: drawDbEvidenceResultPaths.vite.dev,
    run: { lifecycle: "dev", subject: "vite" },
    outcome: "pass",
  },
  {
    path: drawDbEvidenceResultPaths.vite.build,
    run: { lifecycle: "build", subject: "vite" },
    outcome: "pass",
  },
  {
    path: drawDbEvidenceResultPaths.vite.preview,
    run: { lifecycle: "preview", subject: "vite" },
    outcome: "pass",
  },
  {
    path: drawDbEvidenceResultPaths.rsvite.dev,
    run: { lifecycle: "dev", subject: "rsvite" },
    outcome: "fail",
  },
] as const satisfies readonly { path: string; run: DrawDbRun; outcome: "pass" | "fail" }[];

test("the committed DrawDB raw results preserve the Vite baseline and first rsvite entry gap", () => {
  const validators = createContractValidators();
  const corpusManifest = readCorpusManifest();

  for (const evidence of committedEvidence) {
    const result = readResult(evidence.path);
    assertDrawDbResultArtifactsExist(evidence.path, result);
    assert.equal(result["outcome"], evidence.outcome);
    assert.equal(asRecord(result["subject"])["name"], evidence.run.subject);
    assert.deepEqual(result["manifestEntry"], {
      id: DRAWDB_ENTRY_ID,
      sourceCommit: DRAWDB_COMMIT,
    });

    const runManifest = createDrawDbManifest({
      port: portFromResult(result),
      ...evidence.run,
    });
    const command = asRecord(result["command"])["argv"];
    const declaredCommand = asRecord(
      asRecord(drawDbEntryFromManifest(runManifest)["commands"])[evidence.run.lifecycle],
    )["argv"];
    assert.deepEqual(declaredCommand, command);

    for (const manifest of [corpusManifest, runManifest]) {
      const check = validators.validateResultAgainstManifest(manifest, result);
      assert.equal(check.valid, true, check.valid ? "" : JSON.stringify(check.violations));
    }
  }

  const rsviteResult = readResult(drawDbEvidenceResultPaths.rsvite.dev);
  assert.equal(rsviteResult["javascriptApiLevel"], "C0");
  assert.equal(asRecord(rsviteResult["firstIncompatibleBehavior"])["phase"], "dev");
  assert.equal(
    asRecord(rsviteResult["firstIncompatibleBehavior"])["evidencePath"],
    "dev.stderr.log",
  );
  assert.match(
    asRecord(rsviteResult["firstIncompatibleBehavior"])["message"] as string,
    /could not start/,
  );
  assert.match(
    asRecord(rsviteResult["failureClassification"])["evidence"] as string,
    /workspace command failed/,
  );
  assert.ok(
    (rsviteResult["capabilityOwners"] as Array<{ owner: string }>).every(
      (owner) => owner.owner === "rust",
    ),
  );
  assert.throws(
    () =>
      assertDrawDbResultArtifactsExist(drawDbEvidenceResultPaths.vite.dev, {
        ...readResult(drawDbEvidenceResultPaths.vite.dev),
        artifactPaths: ["does-not-exist.log"],
      }),
    /missing evidence does-not-exist\.log/,
  );
});

test("the DrawDB HMR listener accepts only the stylesheet update", () => {
  assert.equal(
    isDrawDbStylesheetUpdate(
      { type: "update", updates: [{ path: DRAWDB_HMR_STYLESHEET_PATH }] },
      DRAWDB_HMR_STYLESHEET_PATH,
    ),
    true,
  );
  assert.equal(
    isDrawDbStylesheetUpdate(
      { type: "update", updates: [{ acceptedPath: DRAWDB_HMR_STYLESHEET_PATH }] },
      DRAWDB_HMR_STYLESHEET_PATH,
    ),
    true,
  );
  assert.equal(
    isDrawDbStylesheetUpdate(
      { type: "update", updates: [{ path: "/src/other.css" }] },
      DRAWDB_HMR_STYLESHEET_PATH,
    ),
    false,
  );
  assert.equal(
    isDrawDbStylesheetUpdate({ type: "custom", updates: [] }, DRAWDB_HMR_STYLESHEET_PATH),
    false,
  );
});

class DrawDbHmrPage implements BrowserPage {
  readonly hmrExpressions: string[] = [];
  readonly stylesheetExpressions: string[] = [];
  #counterSnapshots = [0, 2];

  async evaluate(expression: string, signal: AbortSignal): Promise<unknown> {
    assert.equal(signal.aborted, false);
    const counter = `globalThis.${DRAWDB_HMR_UPDATE_COUNTER}`;
    if (expression === counter) return this.#counterSnapshots.shift() ?? 2;
    if (expression === `${counter} > 0`) {
      this.hmrExpressions.push(expression);
      return true;
    }
    if (expression === `${counter} > 2`) {
      this.hmrExpressions.push(expression);
      return true;
    }
    if (expression.includes("--rsvite-drawdb-hmr-probe")) {
      this.stylesheetExpressions.push(expression);
      return true;
    }
    if (expression.includes('includes("table_")')) return true;
    throw new Error(`unexpected browser expression: ${expression}`);
  }

  drainEvents(): BrowserEvent[] {
    return [];
  }

  async close(): Promise<void> {}
}

test("the deterministic DrawDB HMR seam uses the declared edit and observes its restoration", async () => {
  const page = new DrawDbHmrPage();
  let applies = 0;
  let restores = 0;
  const hmr: HmrUpdate = {
    expectedText: "Add table",
    async apply() {
      applies += 1;
    },
    async restore() {
      restores += 1;
    },
  };

  await updateDrawDbStylesheet(page, new AbortController().signal, hmr);

  assert.equal(applies, 1);
  assert.equal(restores, 1);
  assert.deepEqual(page.hmrExpressions, [
    `globalThis.${DRAWDB_HMR_UPDATE_COUNTER} > 0`,
    `globalThis.${DRAWDB_HMR_UPDATE_COUNTER} > 2`,
  ]);
  assert.equal(page.stylesheetExpressions.length, 2);
  assert.match(page.stylesheetExpressions[0], /"active"/);
  assert.match(page.stylesheetExpressions[1], /=== ""/);
});
