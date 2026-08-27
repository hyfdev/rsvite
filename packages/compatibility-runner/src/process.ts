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
  /** Resolves once no process in the group is left, not merely once the leader closed. */
  stop(): Promise<CommandOutcome>;
  /** Everything written so far, for readiness detection while the process runs. */
  readStdout(): string;
  readStderr(): string;
  /** Resolves when the leader closes. The group may still hold descendants. */
  readonly exited: Promise<void>;
}

const TERMINATION_GRACE_MS = 2_000;
const GROUP_POLL_INTERVAL_MS = 25;
const GROUP_KILL_TIMEOUT_MS = 10_000;

/**
 * Group ids, not `ChildProcess` handles. The leader can exit while its descendants keep the
 * group — and the port — alive, so nothing here may key cleanup on the leader's state.
 */
const liveGroups = new Set<number>();

process.once("exit", () => {
  for (const pgid of liveGroups) signalGroup(pgid, "SIGKILL");
});

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    // ESRCH means the group is gone, which is the state the caller wanted. EPERM means
    // something in it still exists but is not ours to signal, so the group is not gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True while any process still belongs to the group. */
function groupExists(pgid: number): boolean {
  return signalGroup(pgid, 0);
}

async function waitForGroupToDisappear(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupExists(pgid)) return true;
    await delay(GROUP_POLL_INTERVAL_MS);
  }
  return !groupExists(pgid);
}

/**
 * Long-running commands spawn their own children — a package manager wrapping a dev server
 * wrapping a bundler — and killing only the direct child orphans the rest, which then holds
 * the port the next run needs. Every command therefore leads its own process group.
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

/**
 * Removes the whole group. The grace period is measured against the group disappearing, not
 * against the leader closing: a descendant that ignores `SIGTERM`, or one that outlives a
 * leader which exited on its own, must still be gone when this resolves.
 */
async function terminateGroup(pgid: number): Promise<void> {
  if (!groupExists(pgid)) {
    liveGroups.delete(pgid);
    return;
  }

  signalGroup(pgid, "SIGTERM");
  if (await waitForGroupToDisappear(pgid, TERMINATION_GRACE_MS)) {
    liveGroups.delete(pgid);
    return;
  }

  signalGroup(pgid, "SIGKILL");
  const gone = await waitForGroupToDisappear(pgid, GROUP_KILL_TIMEOUT_MS);
  if (gone) {
    liveGroups.delete(pgid);
    return;
  }
  throw new Error(`process group ${String(pgid)} survived SIGKILL`);
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
  const pgid = child.pid;
  if (pgid === undefined) throw new Error("the command did not start");
  liveGroups.add(pgid);

  const buffers = capture(child, logPaths);

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  const exited = once(child, "close").then(([code, closeSignal]) => {
    exitCode = code as number | null;
    signal = closeSignal as NodeJS.Signals | null;
    // Deliberately not removing the group here: the leader closing says nothing about its
    // descendants, and this set exists to make sure none of them is left behind.
  });
  exited.catch(() => undefined);

  return {
    readStdout: () => buffers.stdout,
    readStderr: () => buffers.stderr,
    exited,
    async stop(): Promise<CommandOutcome> {
      await terminateGroup(pgid);
      return { exitCode, signal, timedOut: false, stdout: buffers.stdout, stderr: buffers.stderr };
    },
  };
}

/**
 * Runs a command to completion. A timeout kills the process group and is reported rather than
 * thrown, because a run that timed out is evidence about the subject, not a runner error. The
 * call does not return while any process of the group is still alive, even when the leader
 * exited on its own.
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
