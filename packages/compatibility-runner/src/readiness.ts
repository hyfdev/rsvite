import { setTimeout as delay } from "node:timers/promises";
import type { StartedCommand } from "./process.ts";

/** Readiness exactly as the corpus manifest declares it. */
export type ReadinessSpec =
  | {
      readonly type: "http-ready";
      readonly urlPath: string;
      readonly expectStatus?: number;
      readonly timeoutMs: number;
    }
  | { readonly type: "stdout-pattern"; readonly pattern: string; readonly timeoutMs: number }
  | { readonly type: "process-exit"; readonly timeoutMs: number };

export interface ReadinessOutcome {
  readonly ready: boolean;
  /** Why readiness was not reached, for the record rather than for a thrown error. */
  readonly reason?: string;
}

const POLL_INTERVAL_MS = 100;

/**
 * Waits for the signal the manifest declares. A command that dies while being waited on is
 * reported as not ready rather than polled until the timeout, so a crash is not filed as a
 * slow start.
 */
export async function waitForReadiness(
  spec: ReadinessSpec,
  command: StartedCommand,
  origin: string | undefined,
  now: () => number = Date.now,
): Promise<ReadinessOutcome> {
  const deadline = now() + spec.timeoutMs;

  if (spec.type === "process-exit") {
    const finished = await Promise.race([
      command.exited.then(() => true),
      delay(spec.timeoutMs, false),
    ]);
    return finished
      ? { ready: true }
      : { ready: false, reason: `the command did not exit within ${spec.timeoutMs}ms` };
  }

  let exited = false;
  void command.exited.then(() => {
    exited = true;
  });

  while (now() < deadline) {
    if (await isReady(spec, origin, command)) return { ready: true };
    if (exited) {
      return { ready: false, reason: "the command exited before it reported readiness" };
    }
    await delay(POLL_INTERVAL_MS);
  }

  return { ready: false, reason: `readiness was not reached within ${spec.timeoutMs}ms` };
}

async function isReady(
  spec: Exclude<ReadinessSpec, { type: "process-exit" }>,
  origin: string | undefined,
  command: StartedCommand,
): Promise<boolean> {
  if (spec.type === "stdout-pattern") {
    return new RegExp(spec.pattern).test(command.readStdout());
  }

  if (origin === undefined) {
    throw new Error("http-ready needs the origin the command serves on");
  }

  try {
    const response = await fetch(new URL(spec.urlPath, origin), { redirect: "manual" });
    // The body is never read, so the socket is released rather than held open.
    await response.body?.cancel();
    return response.status === (spec.expectStatus ?? 200);
  } catch {
    return false;
  }
}
