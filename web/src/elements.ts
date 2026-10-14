/**
 * The UI elements page's decisions, kept apart from React so they are tested on their own: when Pay
 * may be pressed, and what a person is told when an element or an action refuses.
 */

/** An error as Perflo.js passes it on: a code, plain words, and the path of a bad field. */
export interface ElementError {
  code: string;
  message: string;
  path?: string;
}

export interface PayState {
  /** The amount element said complete: an amount it accepts, its payment ready for it. */
  amountComplete: boolean;
  /** The payment element said complete: payment details it accepts, ready to confirm. */
  paymentComplete: boolean;
  /** A press of Pay is on its way. */
  paying: boolean;
  /** The money was added; a new payment needs a new page. */
  paid: boolean;
}

/** Pay only when both elements say they are complete, and once per press. */
export function canPay(state: PayState): boolean {
  return state.amountComplete && state.paymentComplete && !state.paying && !state.paid;
}

export const LOAD_FAILED_TEXT = 'This part of the page could not load. Reload the page and try again.';
export const EXPIRED_TEXT = 'This has expired. Start again.';
export const NOT_OFFERED_TEXT = 'This cannot open on this page yet. Use the chat to set up payments and add money.';
const BUSY_TEXT = 'Too many tries. Wait a moment and try again.';
const GENERIC_TEXT = 'Something went wrong. Try again.';

/**
 * Refusals where the element's own words are not for the person: a part that did not load (the
 * words there are for whoever built the page), Tiny asking for something it should not, or a part
 * removed before it finished. These get Tiny's own words.
 */
const TINY_WORDS: ReadonlyMap<string, string> = new Map([
  ['load_failed', LOAD_FAILED_TEXT],
  ['client_secret_mismatch', LOAD_FAILED_TEXT],
  ['not_found', LOAD_FAILED_TEXT],
  ['invalid_request', LOAD_FAILED_TEXT],
  ['element_not_mounted', LOAD_FAILED_TEXT],
  ['element_unmounted', LOAD_FAILED_TEXT],
  ['unsupported_command', GENERIC_TEXT],
  ['internal_error', GENERIC_TEXT],
  ['unknown_error', GENERIC_TEXT],
  ['session_expired', EXPIRED_TEXT],
  ['rate_limited', BUSY_TEXT],
  ['timeout', 'This is taking longer than expected. Try again.'],
]);

/**
 * What the person reads for an element's refusal. Perflo's own words are kept for refusals about
 * what the person did (a code that did not match, a payment the bank declined), since they say
 * what to do next; anything else gets Tiny's words.
 */
export function elementProblem(error: ElementError): string {
  const ours = TINY_WORDS.get(error.code);
  if (ours !== undefined) return ours;
  const words = error.message.trim();
  return words.length > 0 ? words : GENERIC_TEXT;
}

/** True when the refusal means the page's session is over, so the person starts again. */
export function isExpired(error: ElementError): boolean {
  return error.code === 'session_expired';
}
