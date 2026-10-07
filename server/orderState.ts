/**
 * Pure order state handling. Maps the demo's stored order plus the latest
 * Perflo answer to what the browser may see, and decides what the server does
 * next. No I/O here, so every status in SPEC 4 is covered by unit tests.
 */

import type { OrderResponse } from './perfloApi.js';
import type { DemoOrder, DemoUser } from './store.js';
import type { OrderView } from './views.js';

export type { OrderPhase, OrderView } from './views.js';

/** Statuses after which nothing more will happen to the order. */
export const TERMINAL_STATUSES: ReadonlySet<OrderResponse['status']> = new Set([
  'declined',
  'completed',
  'cancelled',
  'expired',
  'failed',
]);

/** Statuses where the order moves on by itself and we should look again shortly. */
export const POLL_STATUSES: ReadonlySet<OrderResponse['status']> = new Set(['issuing']);

export type NextStep = 'reveal' | 'login' | 'none';

/**
 * What the server does with a fresh order answer.
 * - reveal: the card is ready and has not been read for checkout yet
 * - login: the user's access was removed; remember the login to wait on
 * - none: show it and wait (for the user, for time, or for nothing)
 */
export function nextStep(response: OrderResponse, order: Pick<DemoOrder, 'checkout'>): NextStep {
  if (response.status === 'ready') return order.checkout ? 'none' : 'reveal';
  if (response.status === 'login_required') return 'login';
  return 'none';
}

/** The stored copy never keeps the single-use reveal link. */
export function withoutRevealLink(response: OrderResponse): OrderResponse {
  if (response.status !== 'ready') return response;
  const { reveal_url: _url, reveal_expires_at: _expires, ...rest } = response;
  return rest;
}

export function toView(order: DemoOrder, user: DemoUser): OrderView {
  const base: OrderView = {
    id: order.id,
    perfloOrderId: order.perfloOrderId,
    merchantName: order.intent.merchantName,
    domain: order.intent.domain,
    amountCents: order.intent.amountCents,
    description: order.intent.description,
    phase: 'draft',
  };
  if (order.state === 'draft') return base;
  if (order.state === 'discarded') return { ...base, phase: 'discarded' };

  const last = order.last;
  if (last === null) {
    // Not yet with Perflo: either waiting for the one-time setup or about to send.
    if (user.perflo === null && user.pendingLogin !== null) {
      return { ...base, phase: 'needs_setup', frameUrl: user.pendingLogin.loginUrl };
    }
    return { ...base, phase: 'placing' };
  }

  switch (last.status) {
    case 'ready':
      return {
        ...base,
        phase: 'ready',
        cardLast4: last.last4,
        cardLimit: last.card_limit,
        cardExpiresAt: last.card_expires_at,
        ...(order.checkout ? { checkout: order.checkout } : {}),
      };
    case 'payment_required':
      return { ...base, phase: 'payment_required', frameUrl: last.frame_url, amountDue: last.amount_due };
    case 'login_required':
      return { ...base, phase: 'login_required', frameUrl: last.login_url };
    case 'identity_check_required':
      return { ...base, phase: 'identity_check_required', kycUrl: last.kyc_url };
    case 'issuing':
      return { ...base, phase: 'issuing' };
    case 'declined':
      return { ...base, phase: 'declined', declineReason: last.reason, declineMessage: last.message };
    case 'completed':
      return {
        ...base,
        phase: 'completed',
        amountSpent: last.amount_spent,
        amountReturned: last.amount_returned,
        ...(order.checkout ? { checkout: order.checkout } : {}),
      };
    case 'cancelled':
      return {
        ...base,
        phase: 'cancelled',
        ...(order.amountReturned ? { amountReturned: order.amountReturned } : {}),
        ...(order.checkout ? { checkout: order.checkout } : {}),
      };
    case 'expired':
      return { ...base, phase: 'expired', ...(order.checkout ? { checkout: order.checkout } : {}) };
    case 'failed':
      return { ...base, phase: 'failed' };
  }
}
