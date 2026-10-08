/**
 * Reading a one-time card and using it at checkout.
 *
 * The reveal link is a plain GET (no partner headers, no Bearer: the single-use
 * `t` value is the credential) answering the ms-card sensitive-details envelope,
 * decrypted by Evervault on the way out (SPEC 4 clarification). The full card
 * exists only in local variables of these functions: it is never stored,
 * logged or put in an error message. It reaches the browser only through
 * POST /demo/orders/:id/card-details, when the person asks to see an open card.
 */

import { z } from 'zod';
import type { CheckoutSummary, OrderIntent } from './store.js';
import { centsToApiAmount } from './money.js';

const revealEnvelope = z.object({
  success: z.literal(true),
  data: z.object({
    card_number: z.string(),
    cvv: z.string(),
    exp_month: z.union([z.string(), z.number()]),
    exp_year: z.union([z.string(), z.number()]),
    holder_name: z.string().optional(),
    last4: z.string().optional(),
  }),
});

export interface RevealedCard {
  number: string;
  cvv: string;
  expMonth: string;
  expYear: string;
  holderName: string;
  last4: string;
}

export class RevealError extends Error {
  constructor(readonly code: 'unavailable' | 'used_or_expired' | 'still_locked' | 'malformed') {
    super(`card reveal failed: ${code}`);
    this.name = 'RevealError';
  }
}

export async function revealCard(revealUrl: string, fetchImpl: typeof fetch = fetch): Promise<RevealedCard> {
  let response: Response;
  try {
    response = await fetchImpl(revealUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new RevealError('unavailable');
  }
  if (response.status === 404) throw new RevealError('used_or_expired');
  if (!response.ok) throw new RevealError('unavailable');

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RevealError('malformed');
  }
  const parsed = revealEnvelope.safeParse(body);
  if (!parsed.success) throw new RevealError('malformed');
  const d = parsed.data.data;
  const month = String(d.exp_month);
  const year = String(d.exp_year);
  // An ev: value means the relay did not decrypt: the card cannot be used.
  if ([d.card_number, d.cvv, month, year].some((v) => v.startsWith('ev:'))) throw new RevealError('still_locked');

  const number = d.card_number.replace(/[\s-]/g, '');
  if (!/^[0-9]{12,19}$/.test(number) || !/^[0-9]{3,4}$/.test(d.cvv)) throw new RevealError('malformed');
  if (!/^(0?[1-9]|1[0-2])$/.test(month) || !/^([0-9]{2}|[0-9]{4})$/.test(year)) throw new RevealError('malformed');

  return {
    number,
    cvv: d.cvv,
    expMonth: month.padStart(2, '0'),
    expYear: year.length === 2 ? `20${year}` : year,
    holderName: d.holder_name ?? '',
    last4: number.slice(-4),
  };
}

/**
 * Tiny's agent filling the merchant's checkout. With `submitTo` (mock mode) it
 * submits to the mock merchant, which charges the card through the mock.
 * Without it (live mode, or the mock's "stop at checkout" test control) it
 * fills the form and stops, because there is no real merchant to buy from: the
 * card stays open until it is cancelled or expires (12 hours), and unused money
 * goes back to the balance either way.
 */
export async function simulateCheckout(
  card: RevealedCard,
  intent: OrderIntent,
  cardLimit: string,
  submitTo: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutSummary> {
  const form = {
    card_number: card.number,
    cvv: card.cvv,
    exp_month: card.expMonth,
    exp_year: card.expYear,
    name: card.holderName,
    amount: centsToApiAmount(intent.amountCents),
    merchant_domain: intent.domain,
  };
  const summary = {
    last4: card.last4,
    expMonth: card.expMonth,
    expYear: card.expYear,
    cardLimit,
    filledAt: new Date().toISOString(),
  };
  if (submitTo === null) return { ...summary, outcome: 'filled_not_submitted' };

  let charged = false;
  try {
    const response = await fetchImpl(submitTo, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
      signal: AbortSignal.timeout(20_000),
    });
    charged = response.ok;
  } catch {
    charged = false;
  }
  return { ...summary, outcome: charged ? 'charged' : 'charge_refused' };
}
