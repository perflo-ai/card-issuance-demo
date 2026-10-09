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

describe('which orders share a card comes only from the cards payments named', () => {
  it('an order alone on its card is not shared', () => {
    const only = order({ cardId: 'card_a', cardLimit: '10.00' });
    const other = order({ cardId: 'card_b', cardLimit: '20.00' });
    expect(cardUse(only, [only, other])).toEqual({ shared: false, later: false, openTotal: '10.00' });
  });

  it('orders on the same card are shared; only the later ones are "later"; open orders add up', () => {
    const first = order({ createdAt: '2026-10-10T01:00:00Z', cardId: 'card_a', phase: 'completed' });
    const second = order({ createdAt: '2026-10-10T02:00:00Z', cardId: 'card_a', cardLimit: '10.00' });
    const third = order({ createdAt: '2026-10-10T03:00:00Z', cardId: 'card_a', cardLimit: '25.50' });
    const all = [third, first, second];
    expect(cardUse(first, all)).toEqual({ shared: true, later: false, openTotal: '35.50' });
    expect(cardUse(second, all)).toEqual({ shared: true, later: true, openTotal: '35.50' });
    // The list given may leave the order itself out.
    expect(cardUse(third, [first, second])).toEqual({ shared: true, later: true, openTotal: '35.50' });
  });

  it('an order with no card yet shares nothing', () => {
    const waiting = order({ phase: 'issuing' });
    expect(cardUse(waiting, [waiting, order({ phase: 'issuing' })])).toEqual({ shared: false, later: false });
  });
});

describe('open cards are listed one per card', () => {
  const open = (o: OrderView, limit: string, expires: string) => ({
    order_id: o.perfloOrderId as string,
    last4: '4417',
    card_limit: limit,
    expires_at: expires,
  });

  it('orders on one card make one row with their total and the latest end', () => {
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
        shared: true,
      },
    ]);
  });

  it('separate cards stay separate, even with the same last four digits and end', () => {
    const a = order({ cardId: 'card_a' });
    const b = order({ cardId: 'card_b' });
    const rows = openCardRows([open(a, '10.00', '2026-10-10T12:00:00Z'), open(b, '20.00', '2026-10-10T12:00:00Z')], [a, b]);
    expect(rows.map((r) => [r.key, r.total, r.shared])).toEqual([
      ['card:card_a', '10.00', false],
      ['card:card_b', '20.00', false],
    ]);
  });

  it('a card with one open order is still shared when a finished order used it too', () => {
    const paid = order({ cardId: 'card_a', phase: 'completed' });
    const live = order({ cardId: 'card_a', cardLimit: '10.00' });
    expect(openCardRows([open(live, '10.00', '2026-10-10T12:00:00Z')], [paid, live])).toMatchObject([
      { orderIds: [live.perfloOrderId], shared: true },
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
    expect(rows.map((r) => r.key)).toEqual(['order:ord_x', 'order:ord_y']);
  });
});
