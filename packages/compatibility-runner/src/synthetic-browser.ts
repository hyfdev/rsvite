import type { BrowserAdapter, BrowserEvent, BrowserPage } from "./browser.ts";

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
}

export interface SyntheticPage extends BrowserPage {
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

      let memory: Record<string, unknown> = { ...script.documentMemory };
      let pending: BrowserEvent[] = [...(script.openEvents ?? [])];
      let closed = false;

      const page: SyntheticPage = {
        evaluate(expression) {
          if (closed) return Promise.reject(new Error("the page is closed"));
          // A real adapter would evaluate the expression; the synthetic one looks it up, which
          // is enough to model that a replaced document has forgotten what the old one held.
          return Promise.resolve(memory[expression]);
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
        close() {
          closed = true;
          return Promise.resolve();
        },
      };

      void request;
      last = page;
      return Promise.resolve(page);
    },
  };
}
