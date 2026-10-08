/**
 * Every sentence the person reads about money lives here, so each question has
 * one wording. Plain language: no provider names, no technical words.
 */

import type { DeclineReason, IdentityStatus, OrderPhase } from '../../server/views';
import { apiAmountToCents, formatUsd } from '../../server/money';

/** "412.80" from the API -> "$412.80". */
export function money(amount: string): string {
  try {
    return formatUsd(apiAmountToCents(amount));
  } catch {
    return amount;
  }
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
