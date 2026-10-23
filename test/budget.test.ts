import { describe, expect, it } from 'vitest';
import { EventLog } from '../server/eventLog.js';
import { toView } from '../server/orderState.js';
import { accountResponse, orderResponse, PerfloApi, PerfloApiError } from '../server/perfloApi.js';
import type { DemoOrder, DemoUser } from '../server/store.js';
import { declineFallback, declineHint, overBudgetText, resetsEveryText } from '../web/src/copy.js';
import { CREDS } from './helpers.js';

const usd = (amount: string) => ({ amount, currency: 'USD' });

/** GET /v1/users/{id} from Perflo before budgets (bapi main before #401). */
const beforeBudgets = {
  user_id: 'usr_1',
  balance: usd('40.00'),
  limits: { per_order: usd('500.00'), per_month: usd('1000.00'), spent_this_month: usd('50.00'), remaining_this_month: usd('950.00') },
  identity_check: { required_above: '200.00', status: 'not_required' },
  open_cards: [],
  auto_top_up: null,
};

/** The same answer from Perflo with budgets (bapi #401, users.ts describeUser). */
const withBudget = {
  user_id: 'usr_1',
  balance: usd('40.00'),
  budget: {
    amount: '100.00',
    resets_every: { count: 1, unit: 'month' },
    used: '23.40',
    remaining: '76.60',
    period_started_at: '2026-10-23T05:00:00Z',
    resets_at: '2026-11-23T05:00:00Z',
  },
  identity_check: { status: 'not_required', required_above: '200.00', used: '19.85', remaining_before_check: '180.15' },
  next_order: { first_order: true, minimum_amount: '5.00', maximum_amount: '76.60' },
  open_cards: [],
  auto_top_up: 'off',
};

describe('GET /users before and after budgets', () => {
  it('reads the answer from before budgets: limits, and the identity check without its figures', () => {
    const parsed = accountResponse.parse(beforeBudgets);
    expect(parsed.limits?.per_order).toEqual(usd('500.00'));
    expect(parsed.budget).toBeUndefined();
    expect(parsed.next_order).toBeUndefined();
    expect(parsed.identity_check).toEqual({ required_above: '200.00', status: 'not_required' });
  });

  it('reads limits Perflo sends as null when the person set none (bapi capped())', () => {
    const limits = { per_order: null, per_month: null, spent_this_month: usd('0.00'), remaining_this_month: null };
    expect(accountResponse.parse({ ...beforeBudgets, limits }).limits).toEqual(limits);
  });

  it('reads the answer with budgets: the budget, the identity check figures and the next order', () => {
    const parsed = accountResponse.parse(withBudget);
    expect(parsed.limits).toBeUndefined();
    expect(parsed.budget).toEqual(withBudget.budget);
    expect(parsed.identity_check).toEqual(withBudget.identity_check);
    expect(parsed.next_order).toEqual(withBudget.next_order);
  });

  it('reads a person with no budget, and an approved identity check with nothing left to count', () => {
    const parsed = accountResponse.parse({
      ...withBudget,
      budget: null,
      identity_check: { status: 'approved', required_above: '200.00', used: '250.00', remaining_before_check: null },
      next_order: { first_order: false, minimum_amount: '0.01', maximum_amount: null },
    });
    expect(parsed.budget).toBeNull();
    expect(parsed.identity_check.remaining_before_check).toBeNull();
    expect(parsed.next_order?.maximum_amount).toBeNull();
  });

  it('a missing budget, next order or limits never fails the read', () => {
    const { limits: _limits, ...bare } = beforeBudgets;
    expect(accountResponse.safeParse(bare).success).toBe(true);
  });

  it('still refuses an answer outside the contract', () => {
    expect(
      accountResponse.safeParse({ ...withBudget, budget: { ...withBudget.budget, resets_every: { count: 1, unit: 'week' } } }).success,
    ).toBe(false);
    expect(accountResponse.safeParse({ ...withBudget, budget: { ...withBudget.budget, remaining: '-1.00' } }).success).toBe(false);
    expect(
      accountResponse.safeParse({ ...withBudget, next_order: { first_order: true, minimum_amount: '5', maximum_amount: null } }).success,
    ).toBe(false);
  });
});

describe('the signed client reads either Perflo', () => {
  it.each([
    ['before budgets', beforeBudgets],
    ['with budgets', withBudget],
  ])('GET /users %s', async (_name, body) => {
    const api = new PerfloApi(
      'https://perflo.test',
      CREDS,
      new EventLog(),
      async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const { auto_top_up: _ignored, ...expected } = body;
    expect(await api.getAccount('u1', 'usr_1', 'tok')).toEqual(expected);
  });
});

const declined = (reason: unknown) => ({ order_id: 'ord_1', status: 'declined', reason, message: 'Perflo says why.' });

describe('every decline reason Perflo can send', () => {
  it.each([
    'over_order_limit',
    'over_monthly_limit',
    'over_budget',
    'partner_limit',
    'amount_invalid',
    'card_in_use',
    'card_frozen',
    'account_needs_support',
  ])('reads %s', (reason) => {
    expect(orderResponse.parse(declined(reason))).toEqual(declined(reason));
  });

  it('reads a reason this demo does not know yet as other, keeping the message', () => {
    expect(orderResponse.parse(declined('some_future_reason'))).toEqual({ ...declined('other') });
  });

  it('still refuses a decline with no reason, or one that is not words', () => {
    expect(orderResponse.safeParse(declined(undefined)).success).toBe(false);
    expect(orderResponse.safeParse(declined(7)).success).toBe(false);
  });

  it('shows the person an over_budget decline as a declined order', () => {
    const user: DemoUser = {
      id: 'u1',
      createdAt: '2026-10-07T00:00:00Z',
      perflo: { userId: 'usr_1', token: 't' },
      pendingConnection: null,
    };
    const order: DemoOrder = {
      id: 'o1',
      demoUserId: 'u1',
      idempotencyKey: 'k1',
      intent: { merchantName: 'Amazon', domain: 'amazon.com', amountCents: 9000, description: 'chairs' },
      state: 'placed',
      perfloOrderId: 'ord_1',
      last: orderResponse.parse(declined('over_budget')),
      revealUsed: false,
      checkout: null,
      amountReturned: null,
      createdAt: '2026-10-07T00:00:00Z',
    };
    expect(toView(order, user)).toMatchObject({ phase: 'declined', declineReason: 'over_budget', declineMessage: 'Perflo says why.' });
  });
});

describe('POST /checkout/orders answers 409 for a decline outside the order', () => {
  const api = (status: number, body: unknown) =>
    new PerfloApi(
      'https://perflo.test',
      CREDS,
      new EventLog(),
      async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    );
  const input = { user_id: 'usr_1', merchant: { name: 'Amazon', domain: 'amazon.com' }, amount: '10.00', currency: 'USD' as const };

  it.each(['card_in_use', 'card_frozen', 'account_needs_support'])('reads a 409 %s decline as the order answer', async (reason) => {
    const answer = await api(409, declined(reason)).createOrder('u1', 'tok', 'k1', input);
    expect(answer).toEqual(declined(reason));
  });

  it('a 409 refusal is still a refusal', async () => {
    const refusal = api(409, { error: { code: 'order_in_progress', message: 'Busy.' } }).createOrder('u1', 'tok', 'k1', input);
    await expect(refusal).rejects.toBeInstanceOf(PerfloApiError);
    await expect(refusal).rejects.toMatchObject({ code: 'order_in_progress', httpStatus: 409 });
  });
});

describe('what the person reads about a decline', () => {
  it("over budget says when the budget starts again, in the person's own time", () => {
    const text = overBudgetText('2026-11-23T05:00:00Z');
    expect(text).toMatch(/^This is more than what is left of your budget for Tiny\. Your budget starts again on Nov 2[23], 2026, /);
  });

  it('over budget says no date when none is known yet, never a made up one', () => {
    expect(overBudgetText(null)).toBe('This is more than what is left of your budget for Tiny.');
    expect(overBudgetText('not a date')).toBe('This is more than what is left of your budget for Tiny.');
  });

  it('has plain words for every reason, and a hint to raise the budget', () => {
    for (const reason of [
      'over_order_limit',
      'over_monthly_limit',
      'over_budget',
      'partner_limit',
      'amount_invalid',
      'card_in_use',
      'card_frozen',
      'account_needs_support',
      'other',
    ] as const) {
      expect(declineFallback(reason)).toMatch(/^[A-Z][^\u2014\u2013]*\.$/);
    }
    expect(declineHint('over_budget')).toBe('You can raise your budget and ask again.');
  });

  it('says how often the budget starts again', () => {
    expect(resetsEveryText({ count: 1, unit: 'month' })).toBe('every month');
    expect(resetsEveryText({ count: 2, unit: 'day' })).toBe('every 2 days');
    expect(resetsEveryText({ count: 1, unit: 'hour' })).toBe('every hour');
    expect(resetsEveryText({ count: 12, unit: 'month' })).toBe('every 12 months');
  });
});
