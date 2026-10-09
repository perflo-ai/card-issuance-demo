/**
 * How the browser waits on the server. Pure: no React and no DOM, so the
 * rules are unit tested (test/polling.test.ts).
 *
 * - A look is only ever started after the previous one finished, so two
 *   looks never overlap.
 * - Looks stop as soon as the answer is final, when the time budget is used
 *   up, or when the caller stops them.
 * - The wait between looks grows (backoff), and no look is made while the
 *   page is hidden: the next one runs as soon as it is visible again.
 */

export interface Visibility {
  hidden(): boolean;
  /** Calls `listener` each time the page becomes visible. Returns an unsubscribe. */
  onVisible(listener: () => void): () => void;
}

/** For callers with no page to watch (tests, the server). */
export const alwaysVisible: Visibility = { hidden: () => false, onVisible: () => () => undefined };

/** Waits `firstMs`, then `factor` times longer each time, never more than `maxMs`. */
export function backoff(firstMs: number, maxMs: number, factor = 1.5): (attempt: number) => number {
  return (attempt) => Math.min(maxMs, Math.round(firstMs * factor ** attempt));
}

/** Resolves true after `ms`, or false as soon as `signal` stops it. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((done) => {
    if (signal?.aborted) return done(false);
    const stop = () => {
      clearTimeout(timer);
      done(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      done(true);
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Resolves true once the page is visible (at once if it already is), or false if `signal` stops it first. */
export function untilVisible(visibility: Visibility, signal?: AbortSignal): Promise<boolean> {
  return new Promise((done) => {
    if (signal?.aborted) return done(false);
    if (!visibility.hidden()) return done(true);
    const finish = (visible: boolean) => {
      unsubscribe();
      signal?.removeEventListener('abort', stop);
      done(visible);
    };
    const stop = () => finish(false);
    const unsubscribe = visibility.onVisible(() => finish(true));
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export type PollEnd = 'settled' | 'gave_up' | 'stopped';

export interface PollOptions<T> {
  /** One look at the current state. A throw ends the poll and reaches the caller. */
  look: () => Promise<T>;
  /** True when the answer is final and there is nothing more to wait for. */
  settled: (result: T) => boolean;
  /** Milliseconds to wait after look number `attempt` (0 based) before the next one. */
  delay: (attempt: number) => number;
  /** Stop looking (gave_up) once this much time has passed since the first look. */
  budgetMs: number;
  signal?: AbortSignal;
  visibility?: Visibility;
  now?: () => number;
}

/** Looks now, then again with backoff until settled, out of time, or stopped. */
export async function poll<T>(options: PollOptions<T>): Promise<PollEnd> {
  const { look, settled, delay, budgetMs, signal, visibility = alwaysVisible, now = Date.now } = options;
  const started = now();
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return 'stopped';
    const result = await look();
    if (settled(result)) return 'settled';
    if (signal?.aborted) return 'stopped';
    if (now() - started >= budgetMs) return 'gave_up';
    if (!(await sleep(delay(attempt), signal))) return 'stopped';
    if (!(await untilVisible(visibility, signal))) return 'stopped';
  }
}

/**
 * Wraps a load so it never runs twice at once. A call made while it is
 * running does not start a second copy: it asks for one more run after the
 * current one, because whatever changed may have happened after the running
 * load had already read. Any number of calls during a run add up to one more.
 */
export function singleFlight(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await task();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/**
 * Wraps a load so that calls made while it is running join it instead of
 * sending the same request again. For loads that are not answering a change
 * (opening a list), where an answer that is a moment old is the right one.
 */
export function shared(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () =>
    (running ??= task().finally(() => {
      running = null;
    }));
}
