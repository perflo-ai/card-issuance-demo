/**
 * Every sentence the person reads about money lives here, so each question has
 * one wording. Plain language: no provider names, no technical words.
 */

import type { DeclineReason, IdentityStatus, LookId, OrderPhase } from '../../server/views';
import { apiAmountToCents, formatUsd } from '../../server/money';
import type { StepKey } from './progress';

/** "412.80" from the API -> "$412.80". */
export function money(amount: string): string {
  try {
    return formatUsd(apiAmountToCents(amount));
  } catch {
    return amount;
  }
}

/**
 * What went back to the balance after an order: the amount once it is known, or, while a reused card is
 * still open (null), that its unused money comes back when the card closes. Nothing for nothing returned.
 */
export function returnedLine(amountReturned: string | null | undefined): string | null {
  if (amountReturned === null) return 'Unused money comes back when the card closes.';
  return amountReturned && amountReturned !== '0.00' ? `${money(amountReturned)} went back to your balance.` : null;
}

export function declineHint(reason: DeclineReason): string | null {
  switch (reason) {
    case 'over_order_limit':
    case 'over_monthly_limit':
      return 'You can raise your limit and ask again.';
    case 'partner_limit':
      return 'Try again later.';
    case 'amount_invalid':
      return null;
  }
}

export function declineFallback(reason: DeclineReason): string {
  switch (reason) {
    case 'over_order_limit':
      return 'This is more than you allow Tiny to spend on one order.';
    case 'over_monthly_limit':
      return 'This would go over what you allow Tiny to spend each month.';
    case 'partner_limit':
      return 'Tiny cannot place more orders right now.';
    case 'amount_invalid':
      return 'That amount cannot be used for an order.';
  }
}

export function identityText(status: IdentityStatus, requiredAbove: string): string {
  switch (status) {
    case 'not_required':
      return `Not needed until your orders pass ${money(requiredAbove)} in total`;
    case 'required':
      return 'Needed before your next order';
    case 'pending':
      return 'Being checked';
    case 'approved':
      return 'Done';
    case 'rejected':
      return 'Not approved. Contact support.';
  }
}

/** "2026-10-08T07:40:00Z" -> "Oct 8, 7:40 AM". */
export function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function expiry(month: string, year: string): string {
  return `${month}/${year.slice(-2)}`;
}

/** "4242424242424242" -> "4242 4242 4242 4242". */
export function cardNumber(digits: string): string {
  return digits.replace(/(.{4})(?=.)/g, '$1 ');
}

/** One short word or two for where an order stands, used wherever an order is listed. */
export function phaseLabel(phase: OrderPhase): string {
  switch (phase) {
    case 'draft':
      return 'Not sent yet';
    case 'discarded':
      return 'Not sent';
    case 'needs_setup':
      return 'Waiting for setup';
    case 'placing':
      return 'Sending';
    case 'payment_required':
      return 'Needs money added';
    case 'login_required':
      return 'Needs sign-in';
    case 'identity_check_required':
      return 'Needs identity check';
    case 'issuing':
      return 'Getting card ready';
    case 'ready':
      return 'Card open';
    case 'declined':
      return 'Declined';
    case 'completed':
      return 'Paid';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    case 'failed':
      return 'Not completed';
  }
}

/** What Tiny is waiting on while it keeps looking at an order. */
export type Waiting = 'setup' | 'placing' | 'identity' | 'money' | 'card';

/** The line shown while Tiny is waiting on something, in the words of the step. */
export function waitingText(waiting: Waiting): string {
  switch (waiting) {
    case 'setup':
      return 'Finishing setup...';
    case 'placing':
      return 'Placing your order...';
    case 'identity':
      return 'Waiting for your identity check result...';
    case 'money':
      return 'Waiting for your money to arrive...';
    case 'card':
      return 'Getting your card ready...';
  }
}

/** Said when Tiny stopped looking without an answer, with what to do next. */
export function stalledText(waiting: Waiting): string {
  switch (waiting) {
    case 'setup':
      return 'Setup is taking longer than usual.';
    case 'placing':
      return 'Your order is taking longer than usual. Check again in a minute.';
    case 'identity':
      return 'The result has not come through yet. Try again in a minute.';
    case 'money':
      return 'Your money has not arrived yet. If you added it, check again in a minute.';
    case 'card':
      return 'Your card is taking longer than usual to get ready. Check again in a minute.';
  }
}

/**
 * What a card is called: "One-time card", or just "Card" for one the partner reuses for the person's
 * orders until it expires (see cards.ts).
 */
export function cardName(reusable: boolean): string {
  return reusable ? 'Card' : 'One-time card';
}

/** On the card, for an order placed on the same card as an earlier one. */
export const SAME_CARD_TEXT = 'Same card as your last order';

/** The cancel button next to an open order. On a reused card it cancels this order only; the card stays open. */
export function cancelLabel(reusable: boolean): string {
  return reusable ? 'Cancel order' : 'Cancel card';
}

/** Said when a card's cancel has not gone through after about two minutes of trying, next to "Check again". */
export const CANCEL_SLOW_TEXT = 'Cancelling is taking longer than usual. Your money will come back on its own; check again in a minute.';

/** One line per step of an order, for the order's step list. */
export function stepLabel(step: StepKey, domain: string): string {
  switch (step) {
    case 'setup':
      return 'Set up payments';
    case 'identity':
      return 'Identity check';
    case 'money':
      return 'Add money';
    case 'card':
      return 'Get your card ready';
    case 'pay':
      return `Pay at ${domain}`;
  }
}

/** The steps inside the setup frame, in the order the frame asks for them. */
export const SETUP_STEPS = ['Verify it is you', 'Allow Tiny to pay for you', 'Add money if needed'] as const;

/** The example looks, as the Look picker names them. */
export const LOOK_LABELS: Readonly<Record<LookId, string>> = {
  brand: "Tiny's brand (default)",
  flat: 'Flat and light',
  night: 'Dark, with custom inputs',
};
