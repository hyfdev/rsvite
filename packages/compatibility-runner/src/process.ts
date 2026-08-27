import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { sleep, timer } from "./deadline.ts";

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
  /**
   * The command never started. Reporting this as exit code `null` would describe a process that
   * ran and told us nothing, which is a different fact from an executable that does not exist.
   */
  readonly startError?: string;
}

export interface StartedCommand {
  /** Resolves once no process in the group is left, not merely once the leader closed. */
  stop(): Promise<CommandOutcome>;
  /**
   * The leader was already gone when `stop` was called. Decided by asking the operating system,
   * not by whether Node has delivered `close` yet: a process killed during acceptance is dead
   * long before its event arrives, and treating that as "we stopped it" hides the failure.
   */
  exitedOnItsOwn(): boolean;
  /** The reason the command never started, if that is what happened. */
  startErrorSoFar(): string | undefined;
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

/** Signals this runner sent to a group, so an exit can be attributed to us or to something else. */
const sentSignals = new Map<number, Set<NodeJS.Signals>>();

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  if (signal !== 0) {
    const sent = sentSignals.get(pgid) ?? new Set<NodeJS.Signals>();
    sent.add(signal);
    sentSignals.set(pgid, sent);
  }
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
    await sleep(GROUP_POLL_INTERVAL_MS);
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

function capture(
  child: ChildProcess,
  logPaths: { stdout: string; stderr: string } | undefined,
  onSpawnError: (message: string) => void,
): Capture {
  // Streams are closed on `error` as well as on `close`; a command that never started still
  // opened its log files.
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

  const endStreams = (): void => {
    streams?.stdout.end();
    streams?.stderr.end();
  };
  child.once("close", endStreams);
  // The spawn error is written through the same stream the result will point at, and only then
  // is that stream ended. Evidence naming a file that turned out to be empty is worse than
  // naming no evidence at all.
  // Recorded and written here, in the first listener attached to `error`. Node emits `error`
  // before `close`, so anything that waits for `close` already sees the reason by then.
  child.once("error", (error: Error) => {
    const message = String(error);
    onSpawnError(message);
    streams?.stderr.write(`${message}\n`);
    endStreams();
  });
  return buffers;
}

/** Starts a command and leaves it running; the caller decides when it is ready and when to stop. */
export function startCommand(
  command: CommandSpec,
  logPaths?: { stdout: string; stderr: string },
): StartedCommand {
  const child = spawnGroup(command);
  const state: { startError?: string } = {};
  const buffers = capture(child, logPaths, (message) => {
    state.startError = message;
  });

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let closed = false;
  let endedBeforeStop = false;

  // Attached before anything can throw. A command that cannot spawn emits `error`, and an
  // unhandled `error` on a ChildProcess terminates the host — a missing executable is a
  // command failure, not permission to take the orchestrator down with it.
  const failedToSpawn = once(child, "error").then(([error]) => {
    buffers.stderr += `${String(error)}\n`;
    closed = true;
  });

  const closedNormally = once(child, "close").then(([code, closeSignal]) => {
    exitCode = code as number | null;
    signal = closeSignal as NodeJS.Signals | null;
    closed = true;
    // Deliberately not removing the group here: the leader closing says nothing about its
    // descendants, and this set exists to make sure none of them is left behind.
  });

  const exited = Promise.race([closedNormally, failedToSpawn]);
  exited.catch(() => undefined);
  void closedNormally.catch(() => undefined);
  void failedToSpawn.catch(() => undefined);

  const pgid = child.pid;
  if (pgid !== undefined) liveGroups.add(pgid);

  return {
    readStdout: () => buffers.stdout,
    readStderr: () => buffers.stderr,
    exited,
    exitedOnItsOwn: () => endedBeforeStop,
    startErrorSoFar: () => state.startError,
    async stop(): Promise<CommandOutcome> {
      // Whether the command was already over when the stop began. Asking the operating system
      // whether the process still exists cannot answer this: a kill is asynchronous, so a
      // doomed process still reports itself alive for a moment afterwards.
      const alreadyClosed = closed;
      if (pgid !== undefined) await terminateGroup(pgid);
      // The leader's own outcome, not merely the group's absence.
      await exited;
      // Attribution, not timing: the command ended on its own if it was already over, or if
      // what ended it was a signal this runner never sent.
      const ours =
        pgid === undefined ? new Set<NodeJS.Signals>() : (sentSignals.get(pgid) ?? new Set());
      endedBeforeStop = alreadyClosed || (signal !== null && !ours.has(signal));
      if (pgid !== undefined) sentSignals.delete(pgid);
      return {
        exitCode,
        signal,
        timedOut: false,
        stdout: buffers.stdout,
        stderr: buffers.stderr,
        ...(state.startError === undefined ? {} : { startError: state.startError }),
      };
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
  // The losing side of this race must not keep a timer alive: a run that finished in 200ms
  // would otherwise hold an idle host open until its unused timeout fired.
  const expiry = timer(timeoutMs, false);
  let finished: boolean;
  try {
    finished = await Promise.race([started.exited.then(() => true), expiry.promise]);
  } finally {
    expiry.cancel();
  }

  const outcome = await started.stop();
  return finished ? outcome : { ...outcome, timedOut: true };
}
