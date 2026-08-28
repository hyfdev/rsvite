import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_LIBRARY_OVERRIDE } from "@rsvite/compatibility-rsvite-workspace";
import { assertLinuxX64Host } from "../src/index.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDir, "../../..");
const vp = join(repositoryRoot, "node_modules/.bin/vp");

interface PairRecorderSteps {
  readonly preflight: () => void;
  readonly runTask: (task: string) => void;
  readonly recordRsvite: () => void;
}

export function runRsvitePair(steps: PairRecorderSteps): void {
  // Identity, native build and workspace command first: nothing external is touched and no
  // evidence is written until this checkout can name and produce the subject it measures.
  steps.preflight();
  steps.runTask("record:vite-upstream:baseline");
  steps.recordRsvite();
}

export function pairedRecordingEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  for (const name of ["VITE_CHECKOUT", "RUNNER_IMAGE"]) {
    if (source[name] === undefined || source[name] === "") {
      throw new Error(`${name} must identify this recording's pinned input`);
    }
  }

  // The generated loader prefers this over any package-local binary, so a recording that
  // forwarded it would measure a native module nothing here built.
  const { [NATIVE_LIBRARY_OVERRIDE]: overridden, ...forwarded } = source;
  if (overridden !== undefined) {
    process.stderr.write(`ignoring ambient ${NATIVE_LIBRARY_OVERRIDE} for this recording\n`);
  }
  return forwarded;
}

function main(): void {
  const environment = pairedRecordingEnvironment();

  runRsvitePair({
    preflight: () => {
      assertLinuxX64Host();
    },
    runTask: (task) => {
      execFileSync(vp, ["run", "--no-cache", task], {
        cwd: repositoryRoot,
        env: environment,
        stdio: "inherit",
      });
    },
    recordRsvite: () => {
      execFileSync(
        process.execPath,
        ["--experimental-strip-types", join(scriptDir, "record-rsvite-baseline.mts")],
        {
          cwd: repositoryRoot,
          env: environment,
          stdio: "inherit",
        },
      );
    },
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
