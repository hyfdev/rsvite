import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, readFileSync, type WriteStream } from "node:fs";
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
   * The command ended for a reason other than this runner asking it to.
   *
   * Decided after `stop` has run, because none of the easy signals is trustworthy on its own:
   * Node's `close` event may not have been delivered while the host was busy, an exited process
   * that has not been reaped still accepts signals, and a command whose own handler turns a
   * termination into `process.exit(0)` leaves no signal on its outcome at all. The kernel's
   * record of the process, read before anything is signalled, is what settles it.
   *
   * That record exists on Linux, which is the declared evidence environment. Elsewhere this
   * falls back to the weaker evidence above, and that fallback is not reliable attribution: a
   * termination the host was too busy to observe can still be misread as a stop this runner
   * requested. Treat a non-Linux result as unattributed rather than as confirmation.
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

/**
 * What the kernel says about a process, independently of what this host has observed. A
 * process that exited while the host was busy is a zombie until it is reaped: its close event
 * has not been delivered, and it still accepts signals, so neither of those can tell us it is
 * over. Outside Linux there is no such record; the caller then has only the weaker evidence,
 * which can miss an external termination entirely.
 */
function livenessOf(pid: number | undefined): "running" | "ended" | "unknown" {
  if (pid === undefined) return "unknown";
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    // The state letter follows the executable name, which may itself contain spaces.
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    // `Z` is a zombie and `X`/`x` are dead, per proc_pid_stat(5). All three mean the process
    // has finished; only the first is the common case, and reading just it would let the
    // others be misread as a process that was still running.
    return state === "Z" || state === "X" || state === "x" ? "ended" : "running";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "ended" : "unknown";
  }
}

type Delivery = "delivered" | "gone" | "denied";

/**
 * What this runner actually managed to send, and when it first managed it. Recording a signal
 * before the send would count an attempt that failed, and an attempt that failed delivered
 * nothing — so it cannot explain how a process ended.
 */
interface GroupSignals {
  readonly sent: Set<NodeJS.Signals>;
  firstDeliveredAt?: number;
}

const groupSignals = new Map<number, GroupSignals>();

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): Delivery {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    // ESRCH means the group is gone, which is the state the caller wanted. EPERM means
    // something in it still exists but is not ours to signal, so the group is not gone.
    return (error as NodeJS.ErrnoException).code === "EPERM" ? "denied" : "gone";
  }

  if (signal !== 0) {
    const record = groupSignals.get(pgid) ?? { sent: new Set<NodeJS.Signals>() };
    record.sent.add(signal);
    record.firstDeliveredAt ??= Date.now();
    groupSignals.set(pgid, record);
  }
  return "delivered";
}

/** True while any process still belongs to the group. */
function groupExists(pgid: number): boolean {
  return signalGroup(pgid, 0) !== "gone";
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
async function terminateGroup(pgid: number): Promise<{ alreadyGone: boolean }> {
  // The first send is also the question "were you still there?", asked at the only moment that
  // matters. A group that is already gone was ended by something other than this runner.
  const first = signalGroup(pgid, "SIGTERM");
  if (first === "gone") {
    liveGroups.delete(pgid);
    return { alreadyGone: true };
  }

  if (await waitForGroupToDisappear(pgid, TERMINATION_GRACE_MS)) {
    liveGroups.delete(pgid);
    return { alreadyGone: false };
  }

  signalGroup(pgid, "SIGKILL");
  const gone = await waitForGroupToDisappear(pgid, GROUP_KILL_TIMEOUT_MS);
  if (gone) {
    liveGroups.delete(pgid);
    return { alreadyGone: false };
  }
  throw new Error(`process group ${String(pgid)} survived SIGKILL`);
}

/** Resolves when the stream is closed, and rejects if writing it failed. */
function closedOrFailed(stream: WriteStream, path: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("close", resolve);
    stream.once("error", (error: Error) => {
      reject(new Error(`the runner could not write ${path ?? "its log"}: ${String(error)}`));
    });
  });
}

interface Capture {
  stdout: string;
  stderr: string;
}

interface Captured {
  readonly buffers: Capture;
  /** Resolves once the log files are closed, so their existence is a settled fact. */
  readonly flushed: Promise<void>;
}

function capture(
  child: ChildProcess,
  logPaths: { stdout: string; stderr: string } | undefined,
  onSpawnError: (message: string) => void,
): Captured {
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

  // A log that could not be written is not evidence that happens to be missing: the run has
  // no record to point at, so it fails rather than returning a result with a gap in it.
  const flushed =
    streams === undefined
      ? Promise.resolve()
      : Promise.all([
          closedOrFailed(streams.stdout, logPaths?.stdout),
          closedOrFailed(streams.stderr, logPaths?.stderr),
        ]).then(() => undefined);

  // `close` and `error` can both fire for one command, and ending a stream twice would end
  // a stream someone else may already have replaced.
  let ended = false;
  const endStreams = (): void => {
    if (ended) return;
    ended = true;
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
  return { buffers, flushed };
}

/** Starts a command and leaves it running; the caller decides when it is ready and when to stop. */
export function startCommand(
  command: CommandSpec,
  logPaths?: { stdout: string; stderr: string },
): StartedCommand {
  const child = spawnGroup(command);
  const state: { startError?: string } = {};
  const { buffers, flushed } = capture(child, logPaths, (message) => {
    state.startError = message;
  });

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let closed = false;
  let endedAt: number | undefined;
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
    endedAt = Date.now();
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
      // Asked of the kernel before anything is signalled. A process that has already exited
      // but has not been reaped is a zombie, and a zombie still accepts signals — so
      // signalling it successfully proves nothing, and its close event may not have been
      // delivered yet if the host was busy. Its recorded state does not depend on either.
      const stateBeforeStop = livenessOf(child.pid);
      const termination = pgid === undefined ? { alreadyGone: true } : await terminateGroup(pgid);
      // The leader's own outcome, not merely the group's absence, and then its logs: a result
      // that lists only the files that exist must not race the stream still creating them.
      await exited;
      await flushed;

      // Attribution rather than timing. The command ended on its own if it was already over
      // when the stop began, if the group had already vanished by the time this runner first
      // signalled, if what ended it was a signal this runner never delivered, or if it ended
      // before that first delivery. The last two matter because a process can turn an external
      // signal into an ordinary exit: its own handler calling process.exit(0) leaves no signal
      // on the outcome at all, so the signal name alone cannot answer this.
      const record = pgid === undefined ? undefined : groupSignals.get(pgid);
      const deliveredAt = record?.firstDeliveredAt;
      endedBeforeStop =
        alreadyClosed ||
        stateBeforeStop === "ended" ||
        termination.alreadyGone ||
        (signal !== null && record?.sent.has(signal) !== true) ||
        (endedAt !== undefined && deliveredAt !== undefined && endedAt < deliveredAt);
      if (pgid !== undefined) groupSignals.delete(pgid);
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
