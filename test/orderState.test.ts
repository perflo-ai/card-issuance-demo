import { describe, expect, it } from 'vitest';
import { nextStep, POLL_STATUSES, TERMINAL_STATUSES, toView, withoutRevealLink } from '../server/orderState.js';
import type { OrderResponse } from '../server/perfloApi.js';
import type { CheckoutSummary, DemoOrder, DemoUser } from '../server/store.js';
import { redact } from '../server/redact.js';

const user = (over: Partial<DemoUser> = {}): DemoUser => ({
  id: 'u1',
  createdAt: '2026-10-07T00:00:00Z',
  perflo: { userId: 'usr_1', token: 'ptk_test_secret_token' },
  pendingLogin: null,
  ...over,
});

const order = (over: Partial<DemoOrder> = {}): DemoOrder => ({
  id: 'o1',
  demoUserId: 'u1',
  idempotencyKey: 'k1',
  intent: { merchantName: 'United', domain: 'united.com', amountCents: 41280, description: 'flight' },
  state: 'placed',
  perfloOrderId: 'ord_1',
  last: null,
  revealUsed: false,
  checkout: null,
  amountReturned: null,
  createdAt: '2026-10-07T00:00:00Z',
  ...over,
});

const checkout: CheckoutSummary = {
  last4: '4417',
  expMonth: '10',
  expYear: '2029',
  cardLimit: '412.80',
  filledAt: '2026-10-07T00:00:00Z',
  outcome: 'charged',
};

const ready: OrderResponse = {
  order_id: 'ord_1',
  status: 'ready',
  card_id: 'card_1',
  last4: '4417',
  card_limit: '412.80',
  reveal_url: 'https://reveal.example/partner-cards/card_1/sensitive?t=single-use',
  reveal_expires_at: '2026-10-07T00:15:00Z',
  card_expires_at: '2026-10-07T12:00:00Z',
};

describe('every SPEC 4 order status maps to a browser view', () => {
  const cases: Array<[OrderResponse, Record<string, unknown>]> = [
    [ready, { phase: 'ready', cardLast4: '4417', cardLimit: '412.80', cardExpiresAt: '2026-10-07T12:00:00Z' }],
    [
      { order_id: 'ord_1', status: 'payment_required', frame_url: 'https://p.example/frames/top-up?session=fs_1', amount_due: '417.80' },
      { phase: 'payment_required', frameUrl: 'https://p.example/frames/top-up?session=fs_1', amountDue: '417.80' },
    ],
    [
      { order_id: 'ord_1', status: 'login_required', login_id: 'lg_1', login_url: 'https://p.example/frames/setup?session=fs_2' },
      { phase: 'login_required', frameUrl: 'https://p.example/frames/setup?session=fs_2' },
    ],
    [
      { order_id: 'ord_1', status: 'identity_check_required', kyc_url: 'https://kyc.example/x' },
      { phase: 'identity_check_required', kycUrl: 'https://kyc.example/x' },
    ],
    [{ order_id: 'ord_1', status: 'issuing' }, { phase: 'issuing' }],
    [
      { order_id: 'ord_1', status: 'declined', reason: 'over_order_limit', message: 'Too much for one order.' },
      { phase: 'declined', declineReason: 'over_order_limit', declineMessage: 'Too much for one order.' },
    ],
    [
      { order_id: 'ord_1', status: 'completed', amount_spent: '412.80', amount_returned: '4.20' },
      { phase: 'completed', amountSpent: '412.80', amountReturned: '4.20' },
    ],
    [{ order_id: 'ord_1', status: 'cancelled' }, { phase: 'cancelled' }],
    [{ order_id: 'ord_1', status: 'expired' }, { phase: 'expired' }],
    [{ order_id: 'ord_1', status: 'failed' }, { phase: 'failed' }],
  ];

  it.each(cases)('%o', (response, expected) => {
    const view = toView(order({ last: withoutRevealLink(response) }), user());
    expect(view).toMatchObject({ id: 'o1', perfloOrderId: 'ord_1', domain: 'united.com', amountCents: 41280, ...expected });
  });

  it('never exposes the token or the reveal link to the browser', () => {
    const view = JSON.stringify(toView(order({ last: withoutRevealLink(ready) }), user()));
    expect(view).not.toContain('ptk_test_secret_token');
    expect(view).not.toContain('single-use');
    expect(view).not.toContain('reveal');
  });
});

describe('views before Perflo has the order', () => {
  it('draft, discarded and placing', () => {
    expect(toView(order({ state: 'draft', perfloOrderId: null }), user()).phase).toBe('draft');
    expect(toView(order({ state: 'discarded', perfloOrderId: null }), user()).phase).toBe('discarded');
    expect(toView(order({ state: 'placing', perfloOrderId: null }), user()).phase).toBe('placing');
  });

  it('shows the setup frame while the one-time setup is pending', () => {
    const pending = user({ perflo: null, pendingLogin: { loginId: 'lg_1', loginUrl: 'https://p.example/setup?session=fs', orderId: null } });
    expect(toView(order({ state: 'placing', perfloOrderId: null }), pending)).toMatchObject({
      phase: 'needs_setup',
      frameUrl: 'https://p.example/setup?session=fs',
    });
  });
});

describe('what the server does next', () => {
  it('reveals a ready card exactly until checkout happened', () => {
    expect(nextStep(ready, { checkout: null })).toBe('reveal');
    expect(nextStep(ready, { checkout })).toBe('none');
  });

  it('remembers the login for login_required and waits on everything else', () => {
    expect(nextStep({ order_id: 'o', status: 'login_required', login_id: 'l', login_url: 'https://x.example' }, { checkout: null })).toBe('login');
    expect(nextStep({ order_id: 'o', status: 'issuing' }, { checkout: null })).toBe('none');
    expect(nextStep({ order_id: 'o', status: 'payment_required', frame_url: 'https://x.example', amount_due: '1.00' }, { checkout: null })).toBe('none');
  });

  it('knows which statuses are final and which to poll', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'completed', 'declined', 'expired', 'failed']);
    expect([...POLL_STATUSES]).toEqual(['issuing']);
  });

  it('drops the single-use reveal link before storing', () => {
    expect(withoutRevealLink(ready)).not.toHaveProperty('reveal_url');
    expect(withoutRevealLink(ready)).not.toHaveProperty('reveal_expires_at');
    expect(withoutRevealLink(ready)).toMatchObject({ last4: '4417', card_id: 'card_1' });
  });
});

describe('redact', () => {
  it('removes tokens, card data and link capabilities, masks emails', () => {
    const out = redact({
      user_access_token: 'ptk_live_abc',
      Authorization: 'Bearer x',
      email: 'ada@example.com',
      login_url: 'https://api.example/partner/v2/frames/setup?session=fs_secret',
      kyc_url: 'https://kyc.example/start?ref=abc',
      reveal_url: 'https://reveal.example/x?t=abc',
      nested: [{ card_number: '4111111111111111', cvv: '123', exp_month: '10', exp_year: '2029', last4: '1111' }],
      amount: '412.80',
    });
    expect(out).toEqual({
      user_access_token: '[redacted]',
      Authorization: '[redacted]',
      email: 'a***@example.com',
      login_url: 'https://api.example/partner/v2/frames/setup?[redacted]',
      kyc_url: 'https://kyc.example/start?[redacted]',
      reveal_url: '[redacted]',
      nested: [{ card_number: '[redacted]', cvv: '[redacted]', exp_month: '[redacted]', exp_year: '[redacted]', last4: '1111' }],
      amount: '412.80',
    });
  });
});
