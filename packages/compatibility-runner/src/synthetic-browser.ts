import type { BrowserAdapter, BrowserEvent, BrowserPage } from "./browser.ts";

/** Never settles at all, modelling an adapter that does not honour its abort signal. */
function neverSettles(): Promise<never> {
  return new Promise(() => undefined);
}

function paused(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Settles only when the runner gives up, which is what the adapter contract demands. */
function hangs(signal: AbortSignal, what: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error(`${what} was aborted`)), {
      once: true,
    });
  });
}

/**
 * An in-memory adapter used to exercise the orchestration without a real browser. It models the
 * one property that makes the sentinel rule work: a navigation installs a new document, and the
 * new document does not inherit the previous document's memory.
 *
 * It reports events and evaluates expressions. It never decides whether a run passed.
 */
export interface SyntheticScript {
  /** Values the current document exposes to `evaluate`. */
  readonly documentMemory?: Readonly<Record<string, unknown>>;
  /** Events the page emits as soon as it opens. */
  readonly openEvents?: readonly BrowserEvent[];
  /** Fails `open`, standing in for a browser that could not reach the server. */
  readonly failToOpen?: string;
  /**
   * Never settles on its own, standing in for an adapter that hangs. It settles when the
   * runner aborts, which is the behaviour the adapter contract requires.
   */
  readonly hangUntilAborted?: "open" | "evaluate";
  /** Each asynchronous step takes this long, for exercising a cumulative budget. */
  readonly stepDelayMs?: number;
  /** Never settles, not even when aborted — an adapter that breaks the contract. */
  readonly ignoresAbort?: "open" | "evaluate";
  /**
   * `open` settles *successfully* from its abort handler. The adapter obeys the contract, so
   * the page it produced still has to be released by whoever gave up waiting for it.
   */
  readonly resolveOnAbort?: boolean;
  /** `close` rejects, standing in for a page that would not go away. */
  readonly closeFails?: string;
}

export interface SyntheticPage extends BrowserPage {
  /** How many times `close` was called, so a leaked page is observable. */
  closeCalls(): number;
  /** Replaces the current document, as a real full reload would. */
  navigate(url: string, memory?: Readonly<Record<string, unknown>>): void;
  /** Emits an event without replacing the document. */
  emit(event: BrowserEvent): void;
}

export function createSyntheticBrowser(script: SyntheticScript = {}): BrowserAdapter & {
  lastPage(): SyntheticPage | undefined;
} {
  let last: SyntheticPage | undefined;

  return {
    lastPage: () => last,
    open(request) {
      if (script.failToOpen !== undefined) {
        return Promise.reject(new Error(script.failToOpen));
      }

      if (script.ignoresAbort === "open") return neverSettles();
      if (script.hangUntilAborted === "open") return hangs(request.signal, "open");

      let memory: Record<string, unknown> = { ...script.documentMemory };
      let pending: BrowserEvent[] = [...(script.openEvents ?? [])];
      let closed = false;
      let closes = 0;

      const page: SyntheticPage = {
        async evaluate(expression, signal) {
          if (closed) throw new Error("the page is closed");
          if (script.ignoresAbort === "evaluate") return neverSettles();
          if (script.hangUntilAborted === "evaluate") return hangs(signal, "evaluate");
          if (script.stepDelayMs !== undefined) await paused(script.stepDelayMs);
          // A real adapter would evaluate the expression; the synthetic one looks it up, which
          // is enough to model that a replaced document has forgotten what the old one held.
          return memory[expression];
        },
        drainEvents() {
          const drained = pending;
          pending = [];
          return drained;
        },
        navigate(url, nextMemory) {
          memory = { ...nextMemory };
          pending.push({ type: "main-frame-navigated", url });
        },
        emit(event) {
          pending.push(event);
        },
        closeCalls: () => closes,
        close() {
          closes += 1;
          closed = true;
          if (script.closeFails !== undefined) return Promise.reject(new Error(script.closeFails));
          closed = true;
          return Promise.resolve();
        },
      };

      last = page;
      if (script.resolveOnAbort === true) {
        return new Promise((resolve) => {
          request.signal.addEventListener("abort", () => resolve(page), { once: true });
        });
      }
      if (script.stepDelayMs !== undefined) return paused(script.stepDelayMs).then(() => page);
      return Promise.resolve(page);
    },
  };
}
