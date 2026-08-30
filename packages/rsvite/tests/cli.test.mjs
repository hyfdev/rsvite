import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { parseArguments } from "../bin/rsvite.js";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../..");

async function runNode(source) {
  try {
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: repositoryRoot,
    });
    throw new Error("the import unexpectedly succeeded");
  } catch (error) {
    if (error instanceof Error && "stderr" in error) return String(error.stderr);
    throw error;
  }
}

describe("CLI arguments", () => {
  test("accepts one root and a port", () => {
    expect(parseArguments(["fixtures/m1-basic-html", "--port", "0"])).toEqual({
      root: resolve(repositoryRoot, "fixtures/m1-basic-html"),
      port: 0,
      hasExplicitPort: true,
    });
    expect(parseArguments(["--port=4173", "fixtures/m1-basic-html"])).toMatchObject({
      port: 4173,
      hasExplicitPort: true,
    });
    expect(parseArguments(["fixtures/m1-basic-html"])).toMatchObject({
      port: 5173,
      hasExplicitPort: false,
    });
  });

  test.each([
    [["--config", "vite.config.ts"], "--config is not supported"],
    [["build"], "build is not supported"],
    [["preview"], "preview is not supported"],
    [["--host"], "unknown option: --host"],
    [["one", "two"], "unexpected positional argument: two"],
    [["--port", "nope"], "invalid port: nope"],
  ])("rejects unsupported input %j", (arguments_, message) => {
    expect(() => parseArguments(arguments_)).toThrow(message);
  });

  test("reports startup failures once and exits nonzero", async () => {
    await expect(
      execFileAsync("pnpm", ["exec", "rsvite", resolve(repositoryRoot, "fixtures/missing")]),
    ).rejects.toMatchObject({ code: 1 });
    try {
      await execFileAsync("pnpm", ["exec", "rsvite", resolve(repositoryRoot, "fixtures/missing")]);
    } catch (error) {
      expect(String(error.stderr).match(/rsvite:/g)).toHaveLength(1);
    }
  });

  test("does not expose a package root or the private native loader", async () => {
    await expect(runNode('await import("rsvite")')).resolves.toContain(
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
    await expect(runNode('await import("rsvite/native.js")')).resolves.toContain(
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
  });
});
