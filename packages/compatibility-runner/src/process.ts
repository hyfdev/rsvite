import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

/** A command exactly as the corpus manifest records it. */
export interface CommandSpec {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CommandOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface StartedCommand {
  /** Resolves when the process tree is gone, whether it exited or had to be killed. */
  stop(): Promise<CommandOutcome>;
  /** Everything written so far, for readiness detection while the process runs. */
  readStdout(): string;
  readStderr(): string;
  readonly exited: Promise<void>;
}

const TERMINATION_GRACE_MS = 2_000;

/**
 * Every started group is tracked so a normal exit cannot leave one behind. A group survives its
 * parent by design — that is what makes group cleanup possible — so if this process exits while
 * a command is still running, the group has to be killed here or it keeps the port.
 *
 * This covers a normal exit and `process.exit`. A host killed by an unhandled signal never runs
 * exit handlers, and installing signal handlers would change the semantics of whatever embeds
 * this runner, so that case stays the embedder's to handle.
 */
const liveGroups = new Set<ChildProcess>();

process.once("exit", () => {
  for (const child of liveGroups) killGroup(child, "SIGKILL");
});

/**
 * Long-running commands spawn their own children — a package manager wrapping a dev server
 * wrapping a bundler — and killing only the direct child orphans the rest, which then holds
 * the port the next run needs. Every command therefore leads its own process group and is
 * killed by group.
 */
function spawnGroup(command: CommandSpec): ChildProcess {
  const [file, ...args] = command.argv;
  if (file === undefined) throw new Error("a command needs at least an executable");

  return spawn(file, args, {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone, which is the state this call wanted.
  }
}

async function terminate(child: ChildProcess, exited: Promise<void>): Promise<void> {
  killGroup(child, "SIGTERM");
  const settled = await Promise.race([exited.then(() => true), delay(TERMINATION_GRACE_MS, false)]);
  if (settled) return;
  killGroup(child, "SIGKILL");
  await exited;
}

interface Capture {
  stdout: string;
  stderr: string;
}

function capture(child: ChildProcess, logPaths?: { stdout: string; stderr: string }): Capture {
  const buffers: Capture = { stdout: "", stderr: "" };
  const streams = logPaths
    ? { stdout: createWriteStream(logPaths.stdout), stderr: createWriteStream(logPaths.stderr) }
    : undefined;

  child.stdout?.on("data", (chunk: Buffer) => {
    buffers.stdout += chunk.toString("utf8");
    streams?.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    buffers.stderr += chunk.toString("utf8");
    streams?.stderr.write(chunk);
  });
  child.once("close", () => {
    streams?.stdout.end();
    streams?.stderr.end();
  });
  return buffers;
}

/** Starts a command and leaves it running; the caller decides when it is ready and when to stop. */
export function startCommand(
  command: CommandSpec,
  logPaths?: { stdout: string; stderr: string },
): StartedCommand {
  const child = spawnGroup(command);
  liveGroups.add(child);
  const buffers = capture(child, logPaths);

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  const exited = once(child, "close").then(([code, closeSignal]) => {
    exitCode = code as number | null;
    signal = closeSignal as NodeJS.Signals | null;
    liveGroups.delete(child);
  });
  // The process may outlive the run and its exit is then expected, so nothing is left unhandled.
  exited.catch(() => undefined);

  return {
    readStdout: () => buffers.stdout,
    readStderr: () => buffers.stderr,
    exited,
    async stop(): Promise<CommandOutcome> {
      await terminate(child, exited);
      return { exitCode, signal, timedOut: false, stdout: buffers.stdout, stderr: buffers.stderr };
    },
  };
}

/**
 * Runs a command to completion. A timeout kills the process group and is reported rather than
 * thrown, because a run that timed out is evidence about the subject, not a runner error.
 */
export async function runCommand(
  command: CommandSpec,
  timeoutMs: number,
  logPaths?: { stdout: string; stderr: string },
): Promise<CommandOutcome> {
  const started = startCommand(command, logPaths);
  const finished = await Promise.race([started.exited.then(() => true), delay(timeoutMs, false)]);

  const outcome = await started.stop();
  return finished ? outcome : { ...outcome, timedOut: true };
}
