// Run as a subprocess: a command whose executable does not exist must surface as a command
// failure. An unhandled `error` on a ChildProcess terminates the host, so only a separate
// process can show whether that happens.
import { runCommand } from "../src/process.ts";

const outcome = await runCommand({ argv: ["definitely-not-a-real-executable-xyz"] }, 5_000);
console.log(
  JSON.stringify({ exitCode: outcome.exitCode, sawEnoent: /ENOENT/.test(outcome.stderr) }),
);
