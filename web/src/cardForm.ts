/**
 * The card form's decisions, kept apart from React so they are tested on their own: what automatic
 * top-ups the card element is told about, which failed Save can be sent again as it was, and what the
 * person reads when the card element refuses.
 */

import { elementProblem, type ElementError } from './elements';
import type { AutoTopUpChoice } from '../../server/views';

/** The monthly limits Tiny offers, the same ones Perflo's own limits page offers. Perflo decides the bounds. */
export const MONTHLY_LIMIT_CHOICES = ['100.00', '250.00', '500.00', '1000.00'] as const;

/** What the person chose: automatic top-ups up to a limit only when the switch is on and a limit is picked. */
export function autoTopUpChoice(on: boolean, monthlyLimit: string): AutoTopUpChoice {
  return on && monthlyLimit !== '' ? { monthlyLimit } : null;
}

/** Save stays off while the switch is on and no limit is picked: Tiny never picks one for the person. */
export function canSave(on: boolean, monthlyLimit: string): boolean {
  return !on || monthlyLimit !== '';
}

/**
 * True when a Save's answer may never have come back: Tiny was not reached (0) or payments were not
 * (503). That Save is then offered again as it was, with the same card token, so Tiny's server sends
 * the same Idempotency-Key and payments answer it once. Any other answer is final for that Save.
 */
export function canSendAgain(status: number): boolean {
  return status === 0 || status === 503;
}

export const AUTO_TOP_UP_UNAVAILABLE_TEXT =
  'Automatic top-ups are not available for you right now. Turn off "Top up automatically" to save the card on its own.';

/** What the person reads when the card element refuses: Tiny's words where the element's are not for them. */
export function cardProblem(error: ElementError | undefined): string {
  if (!error) return 'Something went wrong. Try again.';
  if (error.code === 'auto_top_up_unavailable') return AUTO_TOP_UP_UNAVAILABLE_TEXT;
  return elementProblem(error);
}
