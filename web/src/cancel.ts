/**
 * Cancelling a card, robust to payments being briefly busy. Pure apart from
 * the request it is given, so the rules are unit tested (test/cancel.test.ts).
 *
 * The card issuer can be busy for a moment while a card is closed, and payments
 * then answers "not available right now" even though the close finishes on its
 * own a minute later. A cancel is safe to send again (payments answers what it
 * recorded), so while the answer means "try again" Tiny keeps the person on
 * "Cancelling..." and sends it again, for about two minutes. Anything else (the
 * card already closed, the order already finished) is a real answer and is
 * shown as it is.
 */

import { ApiError } from './api';
import { alwaysVisible, poll, type Visibility } from './polling';
import type { OrderView } from '../../server/views';

export interface Cancelled {
  /** null while a reused card is open: its unused money comes back when it closes. */
  amountReturned: string | null;
  order?: OrderView;
}

export type CancelOutcome = { kind: 'cancelled'; cancelled: Cancelled } | { kind: 'slow' };

/** The wait after each refused try: 3, 6, 12, then 20 seconds between every later try. */
export const CANCEL_RETRY_DELAYS_MS = [3000, 6000, 12_000, 20_000] as const;
/**
 * Tries stop once this much time has passed after a refused try. One try can itself take up to the
 * server's wait for the close (90 s), so the last answer can come somewhat later than this.
 */
export const CANCEL_BUDGET_MS = 2 * 60_000;

/**
 * Answers that mean "try again": payments is busy or did not answer in time (503), the hosting in
 * front of Tiny gave up waiting (504), or Tiny's server was not reached at all (0).
 */
const TRY_AGAIN: ReadonlySet<number> = new Set([0, 503, 504]);

/**
 * The longest Retry-After honoured: a longer one would leave the person on "Cancelling..." past the two
 * minutes, so the wait is cut here and the budget then ends the tries with the calm message.
 */
const RETRY_AFTER_MAX_MS = 60_000;

function delayAfter(attempt: number, retryAfterMs: number | null): number {
  const planned = CANCEL_RETRY_DELAYS_MS[Math.min(attempt, CANCEL_RETRY_DELAYS_MS.length - 1)] ?? 20_000;
  return retryAfterMs === null ? planned : Math.max(planned, Math.min(retryAfterMs, RETRY_AFTER_MAX_MS));
}

/**
 * Sends the cancel until payments confirms it, or says "slow" after about two minutes of "try
 * again" answers. Any other refusal is thrown as it came, with its own message.
 */
export async function cancelUntilDone(
  send: () => Promise<Cancelled>,
  options: { visibility?: Visibility; now?: () => number } = {},
): Promise<CancelOutcome> {
  const answer: { cancelled: Cancelled | null; retryAfterMs: number | null } = { cancelled: null, retryAfterMs: null };
  const end = await poll({
    look: async () => {
      try {
        answer.cancelled = await send();
        return true;
      } catch (error) {
        if (!(error instanceof ApiError) || !TRY_AGAIN.has(error.status)) throw error;
        answer.retryAfterMs = error.retryAfterMs;
        return false;
      }
    },
    settled: (done) => done,
    delay: (attempt) => delayAfter(attempt, answer.retryAfterMs),
    budgetMs: CANCEL_BUDGET_MS,
    visibility: options.visibility ?? alwaysVisible,
    ...(options.now ? { now: options.now } : {}),
  });
  return end === 'settled' && answer.cancelled ? { kind: 'cancelled', cancelled: answer.cancelled } : { kind: 'slow' };
}
