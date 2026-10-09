/**
 * Which of the person's orders share a card, worked out only from what payments answered: orders whose
 * answers named the same card are on one card. A partner in reuse mode gets the same card back for every
 * order within the card's 12 hours; otherwise each order has its own one-time card. Payments does not say
 * which mode a partner is in, so a card counts as shared once a second order has landed on it. Pure, so
 * it is unit tested (test/cards.test.ts); the words for each case are in copy.ts.
 */

import { apiAmountToCents, centsToApiAmount } from '../../server/money';
import type { AccountView, OrderView } from '../../server/views';

export interface CardUse {
  /** Another order was placed on this order's card: cancelling cancels this order, not the card. */
  shared: boolean;
  /** An earlier order is on this card too. */
  later: boolean;
  /** What the open orders on the card are for together (API amount); absent when none is open. */
  openTotal?: string;
}

const total = (amounts: string[]): string => centsToApiAmount(amounts.reduce((sum, amount) => sum + apiAmountToCents(amount), 0));

/** How `order`'s card is shared with the person's other orders (`orders` may include `order` itself). */
export function cardUse(order: OrderView, orders: readonly OrderView[]): CardUse {
  if (!order.cardId) return { shared: false, later: false };
  const others = orders.filter((o) => o.id !== order.id && o.cardId === order.cardId);
  const open = [order, ...others].flatMap((o) => (o.phase === 'ready' && o.cardLimit ? [o.cardLimit] : []));
  return {
    shared: others.length > 0,
    later: others.some((o) => o.createdAt < order.createdAt),
    ...(open.length > 0 ? { openTotal: total(open) } : {}),
  };
}

/** One line of the Payments panel's open cards: a card, with every open order on it. */
export interface OpenCardRow {
  key: string;
  last4: string;
  /** What its open orders are for together (API amount). */
  total: string;
  /** The latest end of its orders. */
  expiresAt: string;
  /** Payments' ids of its open orders, as payments listed them. */
  orderIds: string[];
  /** The card serves other orders too, open or finished: cancelling one order leaves it open. */
  shared: boolean;
}

/**
 * Payments lists open cards one per order and without the card's id. Each one is matched to the order
 * Tiny placed (by payments' order id), whose answer named the card; orders on the same card make one
 * row. An order Tiny does not know (placed elsewhere) keeps its own row: Tiny does not guess its card.
 */
export function openCardRows(openCards: AccountView['open_cards'], orders: readonly OrderView[]): OpenCardRow[] {
  const byPerfloId = new Map(orders.flatMap((o) => (o.perfloOrderId ? [[o.perfloOrderId, o] as const] : [])));
  const rows = new Map<string, OpenCardRow & { limits: string[] }>();
  for (const open of openCards) {
    const order = byPerfloId.get(open.order_id);
    const key = order?.cardId ? `card:${order.cardId}` : `order:${open.order_id}`;
    const shared = order ? cardUse(order, orders).shared : false;
    const row = rows.get(key);
    if (!row) {
      rows.set(key, {
        key,
        last4: open.last4,
        total: open.card_limit,
        expiresAt: open.expires_at,
        orderIds: [open.order_id],
        shared,
        limits: [open.card_limit],
      });
      continue;
    }
    row.orderIds.push(open.order_id);
    row.limits.push(open.card_limit);
    row.total = total(row.limits);
    if (Date.parse(open.expires_at) > Date.parse(row.expiresAt)) row.expiresAt = open.expires_at;
  }
  return [...rows.values()].map(({ limits: _limits, ...row }) => row);
}
