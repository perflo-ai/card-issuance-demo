import { describe, expect, it } from 'vitest';
import { cardUse, openCardRows } from '../web/src/cards.js';
import type { OrderView } from '../server/views.js';

let n = 0;
const order = (over: Partial<OrderView>): OrderView => {
  n += 1;
  return {
    id: `o${n}`,
    createdAt: `2026-10-10T0${n % 10}:00:00Z`,
    perfloOrderId: `ord_${n}`,
    merchantName: 'Shop',
    domain: 'shop.com',
    amountCents: 1000,
    description: '',
    phase: 'ready',
    ...over,
  };
};

describe("an order's card: payments' word on the mode, the cards it named for the rest", () => {
  it('a one-time order is on a one-time card', () => {
    const only = order({ oneTime: true, cardId: 'card_a', cardLimit: '10.00' });
    expect(cardUse(only, [only, order({ oneTime: true, cardId: 'card_b' })])).toEqual({
      reusable: false,
      later: false,
      openTotal: '10.00',
    });
  });

  it('the first order on a reused card already reads as reused', () => {
    const first = order({ oneTime: false, cardId: 'card_a', cardLimit: '10.00' });
    expect(cardUse(first, [first])).toEqual({ reusable: true, later: false, openTotal: '10.00' });
  });

  it('orders on the same card: only the later ones are "later"; open orders add up', () => {
    const first = order({ createdAt: '2026-10-10T01:00:00Z', oneTime: false, cardId: 'card_a', phase: 'completed' });
    const second = order({ createdAt: '2026-10-10T02:00:00Z', oneTime: false, cardId: 'card_a', cardLimit: '10.00' });
    const third = order({ createdAt: '2026-10-10T03:00:00Z', oneTime: false, cardId: 'card_a', cardLimit: '25.50' });
    const all = [third, first, second];
    expect(cardUse(first, all)).toEqual({ reusable: true, later: false, openTotal: '35.50' });
    expect(cardUse(second, all)).toEqual({ reusable: true, later: true, openTotal: '35.50' });
    // The list given may leave the order itself out.
    expect(cardUse(third, [first, second])).toEqual({ reusable: true, later: true, openTotal: '35.50' });
  });

  describe('when payments did not say the mode (older answers)', () => {
    it('a card is one-time while it serves one order', () => {
      const only = order({ cardId: 'card_a', cardLimit: '10.00' });
      expect(cardUse(only, [only, order({ cardId: 'card_b' })])).toEqual({ reusable: false, later: false, openTotal: '10.00' });
    });

    it('and reused once a second order is on it', () => {
      const first = order({ createdAt: '2026-10-10T01:00:00Z', cardId: 'card_a', phase: 'completed' });
      const second = order({ createdAt: '2026-10-10T02:00:00Z', cardId: 'card_a', cardLimit: '10.00' });
      expect(cardUse(first, [first, second])).toEqual({ reusable: true, later: false, openTotal: '10.00' });
      expect(cardUse(second, [first, second])).toEqual({ reusable: true, later: true, openTotal: '10.00' });
    });
  });

  it('payments saying one-time wins over anything inferred', () => {
    const a = order({ oneTime: true, cardId: 'card_a' });
    const b = order({ oneTime: true, cardId: 'card_a' });
    expect(cardUse(a, [a, b]).reusable).toBe(false);
  });

  it('an order with no card yet adds nothing up', () => {
    const waiting = order({ phase: 'issuing' });
    expect(cardUse(waiting, [waiting, order({ phase: 'issuing' })])).toEqual({ reusable: false, later: false });
  });
});

describe('open cards are listed one per card', () => {
  const open = (o: OrderView, limit: string, expires: string, cardId?: string) => ({
    order_id: o.perfloOrderId as string,
    ...(cardId ? { card_id: cardId } : {}),
    last4: '4417',
    card_limit: limit,
    expires_at: expires,
  });

  it('entries with the same card_id make one row with their total and the latest end, even for orders Tiny did not place', () => {
    const rows = openCardRows(
      [
        { order_id: 'ord_x', card_id: 'card_a', last4: '4417', card_limit: '10.00', expires_at: '2026-10-10T12:00:00Z' },
        { order_id: 'ord_y', card_id: 'card_a', last4: '4417', card_limit: '20.05', expires_at: '2026-10-10T13:00:00Z' },
      ],
      [],
    );
    expect(rows).toEqual([
      {
        key: 'card:card_a',
        last4: '4417',
        total: '30.05',
        expiresAt: '2026-10-10T13:00:00Z',
        orderIds: ['ord_x', 'ord_y'],
        reusable: true,
      },
    ]);
  });

  it('separate cards stay separate, even with the same last four digits and end', () => {
    const a = order({ oneTime: true, cardId: 'card_a' });
    const b = order({ oneTime: true, cardId: 'card_b' });
    const rows = openCardRows(
      [open(a, '10.00', '2026-10-10T12:00:00Z', 'card_a'), open(b, '20.00', '2026-10-10T12:00:00Z', 'card_b')],
      [a, b],
    );
    expect(rows.map((r) => [r.key, r.total, r.reusable])).toEqual([
      ['card:card_a', '10.00', false],
      ['card:card_b', '20.00', false],
    ]);
  });

  it("a reused card with one open order says so, from the order's mode", () => {
    const live = order({ oneTime: false, cardId: 'card_a', cardLimit: '10.00' });
    expect(openCardRows([open(live, '10.00', '2026-10-10T12:00:00Z', 'card_a')], [live])).toMatchObject([
      { orderIds: [live.perfloOrderId], reusable: true },
    ]);
  });

  describe('when payments did not send the card id (older answers)', () => {
    it("entries are matched to Tiny's own orders by order id, and orders on one card make one row", () => {
      const a = order({ cardId: 'card_a', cardLimit: '10.00' });
      const b = order({ cardId: 'card_a', cardLimit: '20.05' });
      const rows = openCardRows([open(a, '10.00', '2026-10-10T12:00:00Z'), open(b, '20.05', '2026-10-10T13:00:00Z')], [a, b]);
      expect(rows).toEqual([
        {
          key: 'card:card_a',
          last4: '4417',
          total: '30.05',
          expiresAt: '2026-10-10T13:00:00Z',
          orderIds: [a.perfloOrderId, b.perfloOrderId],
          reusable: true,
        },
      ]);
    });

    it('an open card Tiny did not place keeps its own row: its card is not guessed', () => {
      const rows = openCardRows(
        [
          { order_id: 'ord_x', last4: '4417', card_limit: '10.00', expires_at: '2026-10-10T12:00:00Z' },
          { order_id: 'ord_y', last4: '4417', card_limit: '10.00', expires_at: '2026-10-10T12:00:00Z' },
        ],
        [],
      );
      expect(rows.map((r) => [r.key, r.reusable])).toEqual([
        ['order:ord_x', false],
        ['order:ord_y', false],
      ]);
    });
  });
});
