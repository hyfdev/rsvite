/**
 * What an adapter observed, never what it concluded. An adapter reports events and evaluates
 * expressions in the current document; deciding whether a run passed is the runner's job, so
 * every subject is judged by the same rule instead of by whichever adapter drove it.
 */
export type BrowserEvent =
  | { readonly type: "console-error"; readonly message: string; readonly url?: string }
  | { readonly type: "page-error"; readonly message: string; readonly url?: string }
  | { readonly type: "request-failed"; readonly url: string; readonly message: string }
  | { readonly type: "main-frame-navigated"; readonly url: string };

/**
 * Every asynchronous entry point takes the runner's `AbortSignal` and must settle once it is
 * aborted. Without that, a deadline could only stop the runner from waiting while the adapter
 * kept driving a browser the run had already left behind.
 */
export interface BrowserPage {
  /**
   * Evaluates in the *current* document. A document that replaced another cannot see the
   * previous document's memory, which is what makes an in-memory sentinel meaningful.
   */
  evaluate(expression: string, signal: AbortSignal): Promise<unknown>;
  /** Events observed since the last drain, in order. */
  drainEvents(): BrowserEvent[];
  close(signal: AbortSignal): Promise<void>;
}

export interface BrowserAdapter {
  open(request: {
    readonly url: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<BrowserPage>;
}

/** The browser-side facts a raw result records, normalized away from any adapter's shape. */
export interface BrowserObservation {
  readonly errors: readonly {
    readonly type: "console-error" | "page-error" | "request-failure";
    readonly message: string;
    readonly url?: string;
  }[];
  readonly mainFrameNavigations: number;
}

export function normalizeEvents(events: readonly BrowserEvent[]): BrowserObservation {
  const errors: BrowserObservation["errors"][number][] = [];
  let mainFrameNavigations = 0;

  for (const event of events) {
    switch (event.type) {
      case "console-error":
      case "page-error":
        errors.push({
          type: event.type,
          message: event.message,
          ...(event.url ? { url: event.url } : {}),
        });
        break;
      case "request-failed":
        errors.push({ type: "request-failure", message: event.message, url: event.url });
        break;
      case "main-frame-navigated":
        mainFrameNavigations += 1;
        break;
    }
  }

  return { errors, mainFrameNavigations };
}

export interface UpdateWindow {
  readonly sentinelBefore: unknown;
  readonly sentinelAfter: unknown;
  readonly events: readonly BrowserEvent[];
}

export interface UpdateVerdict {
  readonly fullReload: boolean;
  readonly reason?: string;
}

/**
 * The compatibility record's rule, applied here once for every subject: an update that
 * navigated the main frame is a full reload, and an update the in-memory sentinel did not
 * survive is a full reload that the navigation record happened to miss. Persisted state
 * would survive either, which is why the sentinel has to be in memory.
 */
export function judgeUpdateWindow(window: UpdateWindow): UpdateVerdict {
  const navigation = window.events.find((event) => event.type === "main-frame-navigated");
  if (navigation !== undefined) {
    return {
      fullReload: true,
      reason: `the main frame navigated to ${navigation.url} during the update window`,
    };
  }
  if (!Object.is(window.sentinelBefore, window.sentinelAfter)) {
    return {
      fullReload: true,
      reason: "the in-memory sentinel did not survive the update, so the document was replaced",
    };
  }
  return { fullReload: false };
}
