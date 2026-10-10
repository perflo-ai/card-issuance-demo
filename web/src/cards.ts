/**
 * What kind of card an order is on, and which of the person's orders share a card, worked out only from
 * what payments answered. A partner in reuse mode gets the same card back for every order within the
 * card's 12 hours, and cancelling one order leaves the card open; otherwise each order has its own
 * one-time card. Payments says which on every order answer (`one_time`). A payments service that does not
 * say yet is read from the cards it named: a card counts as reused once a second order has landed on it.
 * Pure, so it is unit tested (test/cards.test.ts); the words for each case are in copy.ts.
 */

import { apiAmountToCents, centsToApiAmount } from '../../server/money';
import type { AccountView, OrderView } from '../../server/views';

export interface CardUse {
  /** Not a one-time card: it serves the person's orders until it expires, and cancelling cancels this order only. */
  reusable: boolean;
  /** An earlier order is on this card too. */
  later: boolean;
  /** What the open orders on the card are for together (API amount); absent when none is open. */
  openTotal?: string;
}

const total = (amounts: string[]): string => centsToApiAmount(amounts.reduce((sum, amount) => sum + apiAmountToCents(amount), 0));

/** The card `order` is on, next to the person's other orders (`orders` may include `order` itself). */
export function cardUse(order: OrderView, orders: readonly OrderView[]): CardUse {
  const others = order.cardId ? orders.filter((o) => o.id !== order.id && o.cardId === order.cardId) : [];
  const open = [order, ...others].flatMap((o) => (o.cardId && o.phase === 'ready' && o.cardLimit ? [o.cardLimit] : []));
  return {
    // Payments' word when it gave it; otherwise a card is known to be reused only once it serves two orders.
    reusable: order.oneTime !== undefined ? !order.oneTime : others.length > 0,
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
  /** Not a one-time card: cancelling one of its orders leaves it open. */
  reusable: boolean;
}

/**
 * Payments lists open cards one per order, each with its card's id; entries with the same card make one
 * row. A payments service that does not send the card's id yet: each entry is matched to the order Tiny
 * placed (by payments' order id), whose answer named the card, and an order Tiny does not know keeps its
 * own row, because Tiny does not guess its card.
 */
export function openCardRows(openCards: AccountView['open_cards'], orders: readonly OrderView[]): OpenCardRow[] {
  const byPerfloId = new Map(orders.flatMap((o) => (o.perfloOrderId ? [[o.perfloOrderId, o] as const] : [])));
  const rows = new Map<string, OpenCardRow & { limits: string[] }>();
  for (const open of openCards) {
    const order = byPerfloId.get(open.order_id);
    const cardId = open.card_id ?? order?.cardId;
    const key = cardId ? `card:${cardId}` : `order:${open.order_id}`;
    const reusable = order ? cardUse(order, orders).reusable : false;
    const row = rows.get(key);
    if (!row) {
      rows.set(key, {
        key,
        last4: open.last4,
        total: open.card_limit,
        expiresAt: open.expires_at,
        orderIds: [open.order_id],
        reusable,
        limits: [open.card_limit],
      });
      continue;
    }
    row.orderIds.push(open.order_id);
    row.limits.push(open.card_limit);
    row.total = total(row.limits);
    // Two open orders on one card: it is not a one-time card, whatever is known about either order.
    row.reusable = true;
    if (Date.parse(open.expires_at) > Date.parse(row.expiresAt)) row.expiresAt = open.expires_at;
  }
  return [...rows.values()].map(({ limits: _limits, ...row }) => row);
}
