import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quote } from '../server/mock/mockPerflo.js';
import { apiAmountToCents, centsToApiAmount } from '../server/money.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { finishSetup, frameCall, payInFrame, revealFetch, signedFetch, startMock, wait, WEBHOOK_SECRET } from './helpers.js';

let mock: { base: string; close: () => Promise<void> };
beforeEach(async () => {
  mock = await startMock(50);
});
afterEach(async () => {
  await mock.close();
});

/** A linked user with a budget and a token, plus an optional balance. */
async function linkedUser(
  externalId = 'ext-1',
  email = 'ada@example.com',
  balance?: string,
  limits: unknown = { budget: 100000, resets_every: { count: 1, unit: 'month' } },
) {
  const created = await signedFetch(mock.base, 'POST', '/v1/users', { body: { external_user_id: externalId, email } });
  expect(created.status).toBe(202);
  await finishSetup(mock.base, created.json.connect_url, limits);
  const connection = await signedFetch(mock.base, 'GET', `/v1/connections/${created.json.connection_id}`);
  const token = connection.json.user_access_token as string;
  const userId = connection.json.user_id as string;
  if (balance) {
    const link = await signedFetch(mock.base, 'POST', `/v1/users/${userId}/top-ups`, { token, body: { amount: balance } });
    await payInFrame(mock.base, link.json.frame_url, balance);
  }
  return { token, userId };
}

const order = (userId: string, amount: string, domain = 'amazon.com') => ({
  user_id: userId,
  merchant: { name: 'Shop', domain },
  amount,
  currency: 'USD',
});

describe('signature check', () => {
  it('refuses unsigned and wrongly signed requests with the error envelope', async () => {
    const unsigned = await fetch(`${mock.base}/v1/users`, { method: 'POST' });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({ error: { code: 'unauthorized', message: 'We could not confirm who sent this request.' } });
    const wrong = await signedFetch(mock.base, 'POST', '/v1/users', { body: { external_user_id: 'x' }, secret: 'B'.repeat(43) });
    expect(wrong.status).toBe(401);
  });

  it('refuses a body that differs from the signed one', async () => {
    const { signatureHeaders } = await import('../server/signing.js');
    const { CREDS } = await import('./helpers.js');
    const signed = signatureHeaders(CREDS, 'POST', '/v1/users', Buffer.from('{"external_user_id":"a"}'));
    const response = await fetch(`${mock.base}/v1/users`, {
      method: 'POST',
      headers: { ...signed, 'Content-Type': 'application/json' },
      body: '{"external_user_id":"b"}',
    });
    expect(response.status).toBe(401);
  });
});

describe('users and connections', () => {
  it('connection_required, then approved with the token exactly once', async () => {
    const created = await signedFetch(mock.base, 'POST', '/v1/users', {
      body: { external_user_id: 'ext-1', email: 'ada@example.com' },
    });
    expect(created.status).toBe(202);
    expect(created.json).toEqual({
      status: 'connection_required',
      connection_id: expect.stringMatching(/^lg_/),
      connect_url: expect.stringContaining('/v1/frames/setup?session=fs_'),
      client_secret: expect.any(String),
      expires_at: expect.any(String),
    });

    expect((await signedFetch(mock.base, 'GET', `/v1/connections/${created.json.connection_id}`)).json).toEqual({ status: 'pending' });
    // The frame knows the email, so the code is already sent: the first step is the code.
    expect((await frameCall(mock.base, created.json.connect_url, 'state')).json).toMatchObject({
      purpose: 'setup',
      step: 'login',
      email_masked: 'a***@example.com',
    });
    await finishSetup(mock.base, created.json.connect_url);

    const first = await signedFetch(mock.base, 'GET', `/v1/connections/${created.json.connection_id}`);
    expect(first.json).toMatchObject({
      status: 'approved',
      user_id: expect.stringMatching(/^usr_/),
      user_access_token: expect.stringMatching(/^ptk_test_/),
    });
    const second = await signedFetch(mock.base, 'GET', `/v1/connections/${created.json.connection_id}`);
    expect(second.json).toEqual({ status: 'approved', user_id: first.json.user_id });
  });

  it('answers no login names: GET /v1/logins is gone, and an unknown connection is 404', async () => {
    const created = await signedFetch(mock.base, 'POST', '/v1/users', { body: { external_user_id: 'ext-1' } });
    expect(created.json).not.toHaveProperty('login_id');
    expect(created.json).not.toHaveProperty('login_url');
    expect((await signedFetch(mock.base, 'GET', `/v1/logins/${created.json.connection_id}`)).status).toBe(404);
    const unknown = await signedFetch(mock.base, 'GET', '/v1/connections/lg_nobody');
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe('not_found');
  });

  it('approved without a token for a known external id; reissue mints a new one and revokes the old', async () => {
    const { token, userId } = await linkedUser();
    const again = await signedFetch(mock.base, 'POST', '/v1/users', { body: { external_user_id: 'ext-1' } });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ status: 'approved', user_id: userId });

    const reissued = await signedFetch(mock.base, 'POST', '/v1/users', { body: { external_user_id: 'ext-1', reissue: true } });
    expect(reissued.json.user_access_token).toMatch(/^ptk_test_/);
    expect(reissued.json.user_access_token).not.toBe(token);
    expect((await signedFetch(mock.base, 'GET', `/v1/users/${userId}`, { token })).status).toBe(401);
    expect((await signedFetch(mock.base, 'GET', `/v1/users/${userId}`, { token: reissued.json.user_access_token })).status).toBe(200);
  });

  it('never grants access by email alone: a new external id must connect', async () => {
    await linkedUser('ext-1', 'ada@example.com');
    const other = await signedFetch(mock.base, 'POST', '/v1/users', {
      body: { external_user_id: 'ext-2', email: 'ada@example.com' },
    });
    expect(other.status).toBe(202);
    expect(other.json.status).toBe('connection_required');
  });

  it('a wrong code is refused in plain words', async () => {
    const created = await signedFetch(mock.base, 'POST', '/v1/users', {
      body: { external_user_id: 'ext-1', email: 'ada@example.com' },
    });
    const wrong = await frameCall(mock.base, created.json.connect_url, 'login', { privy_access_token: 'mock-otp:000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error).toEqual({ code: 'connection_failed', message: 'That code is not right. Check it and try again.' });
  });

  it('account shape matches SPEC 4', async () => {
    await mock.close();
    mock = await startMock(50, undefined, false, () => Date.parse('2026-10-23T05:00:00Z'));
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const account = await signedFetch(mock.base, 'GET', `/v1/users/${userId}`, { token });
    expect(account.json).toEqual({
      user_id: userId,
      balance: { amount: '100.00', currency: 'USD' },
      budget: {
        amount: '1000.00',
        resets_every: { count: 1, unit: 'month' },
        used: '0.00',
        remaining: '1000.00',
        period_started_at: '2026-10-23T05:00:00.000Z',
        resets_at: '2026-11-23T05:00:00.000Z',
      },
      identity_check: { status: 'not_required', required_above: '200.00', used: '0.00', remaining_before_check: '200.00' },
      next_order: { first_order: true, minimum_amount: '5.00', maximum_amount: '200.00' },
      open_cards: [],
    });
  });

  it('after the first card and the identity check, the next order can be any amount up to what is left', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '400.00', {
      budget: 30000,
      resets_every: { count: 2, unit: 'day' },
    });
    const placed = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '250.00') });
    expect(placed.json.status).toBe('identity_check_required');
    const ref = new URL(placed.json.kyc_url).searchParams.get('ref') as string;
    await fetch(`${mock.base}/mock/kyc`, { method: 'POST', body: new URLSearchParams({ ref }) });
    expect(['issuing', 'ready']).toContain(
      (await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${placed.json.order_id}`)).json.status,
    );
    const account = await signedFetch(mock.base, 'GET', `/v1/users/${userId}`, { token });
    expect(account.json).toMatchObject({
      budget: { amount: '300.00', resets_every: { count: 2, unit: 'day' }, used: '250.00', remaining: '50.00' },
      identity_check: { status: 'approved', used: '250.00', remaining_before_check: null },
      next_order: { first_order: false, minimum_amount: '0.01', maximum_amount: '50.00' },
    });
  });
});

describe('orders', () => {
  it('requires an Idempotency-Key and replays the stored answer for the same key', async () => {
    const { token, userId } = await linkedUser();
    expect((await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, body: order(userId, '10.00') })).status).toBe(400);
    const first = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '10.00') });
    const again = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '10.00') });
    expect(again).toEqual(first);
    const conflict = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '11.00') });
    expect(conflict.status).toBe(409);
  });

  it('payment_required, then ready after the money lands (retry is a GET)', async () => {
    const { token, userId } = await linkedUser();
    const placed = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '50.00') });
    expect(placed.status).toBe(202);
    expect(placed.json).toMatchObject({ status: 'payment_required', amount_due: centsToApiAmount(quote(5000).totalCents) });
    await payInFrame(mock.base, placed.json.frame_url, placed.json.amount_due);
    const now = await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${placed.json.order_id}`);
    expect(now.status).toBe(200);
    expect(now.json).toMatchObject({ status: 'ready', last4: expect.stringMatching(/^[0-9]{4}$/), card_limit: '50.00' });
    // GET never repeats the single-use reveal link.
    expect(now.json).not.toHaveProperty('reveal_url');
  });

  it('ready on POST carries a single-use reveal link answering the ms-card envelope', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const placed = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    expect(placed.status).toBe(201);
    expect(placed.json).toMatchObject({
      status: 'ready',
      card_id: expect.any(String),
      reveal_url: expect.any(String),
      reveal_expires_at: expect.any(String),
      card_expires_at: expect.any(String),
    });
    // Refused the same way whatever is wrong, and the link stays usable after each refusal.
    const other = await linkedUser('ext-2', 'grace@example.com');
    for (const refused of [
      await fetch(placed.json.reveal_url),
      await revealFetch(placed.json.reveal_url, null),
      await revealFetch(placed.json.reveal_url, other.token),
      await revealFetch(placed.json.reveal_url, token, 'B'.repeat(43)),
    ]) {
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ success: false, error: 'This link has expired or was already used.' });
    }
    const reveal = await revealFetch(placed.json.reveal_url, token);
    const body = await reveal.json();
    expect(body).toMatchObject({
      success: true,
      data: { card_number: expect.stringMatching(/^[0-9]{16}$/), cvv: expect.stringMatching(/^[0-9]{3}$/), last4: placed.json.last4 },
    });
    expect((await revealFetch(placed.json.reveal_url, token)).status).toBe(404);
    const fresh = await signedFetch(mock.base, 'POST', `/v1/checkout/orders/${placed.json.order_id}/card-reveal`, { token });
    expect(fresh.status).toBe(201);
    expect((await revealFetch(fresh.json.reveal_url, token)).status).toBe(200);
  });

  it('issuing, then ready on GET', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '200.00');
    const placed = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '150.00') });
    expect(placed.status).toBe(202);
    expect(placed.json).toEqual({ order_id: placed.json.order_id, one_time: true, status: 'issuing' });
    await wait(80);
    expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${placed.json.order_id}`)).json.status).toBe('ready');
  });

  it('identity_check_required once total card spending would pass $200, then continues after the check', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '400.00');
    const first = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '80.00') });
    expect(first.status).toBe(201);
    const second = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k2', body: order(userId, '130.00') });
    expect(second.status).toBe(202);
    expect(second.json).toMatchObject({ status: 'identity_check_required', kyc_url: expect.stringContaining('/mock/kyc?ref=') });
    const ref = new URL(second.json.kyc_url).searchParams.get('ref') as string;
    await fetch(`${mock.base}/mock/kyc`, { method: 'POST', body: new URLSearchParams({ ref }) });
    const resumed = await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${second.json.order_id}`);
    expect(['issuing', 'ready']).toContain(resumed.json.status);
  });

  it.each([
    ['2600.00', 'amount_invalid'],
    ['10.5', 'amount_invalid'],
    ['0.00', 'amount_invalid'],
  ])('declines %s with %s (422)', async (amount, reason) => {
    const { token, userId } = await linkedUser();
    const placed = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: `k-${amount}`, body: order(userId, amount) });
    expect(placed.status).toBe(422);
    expect(placed.json).toMatchObject({ order_id: expect.any(String), status: 'declined', reason, message: expect.any(String) });
    if (amount === '2600.00') expect(placed.json.message).toBe('Cards can be up to $2,500 each.');
  });

  it('declines over the budget, says when it starts again, and takes orders again once it has', async () => {
    let clock = Date.parse('2026-10-23T05:00:00Z');
    await mock.close();
    mock = await startMock(50, undefined, false, () => clock);
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '1000.00', {
      budget: 60000,
      resets_every: { count: 1, unit: 'month' },
    });
    const first = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'a', body: order(userId, '450.00') });
    expect(first.json.status).toBe('identity_check_required');
    const ref = new URL(first.json.kyc_url).searchParams.get('ref') as string;
    await fetch(`${mock.base}/mock/kyc`, { method: 'POST', body: new URLSearchParams({ ref }) });
    expect(['issuing', 'ready']).toContain((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${first.json.order_id}`)).json.status);
    const over = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'b', body: order(userId, '200.00') });
    expect(over.status).toBe(422);
    expect(over.json).toMatchObject({ status: 'declined', reason: 'over_budget' });
    expect(over.json.message).toBe('This order is more than this user’s remaining budget. It resets on Nov 23, 2026 at 5:00 AM UTC.');
    clock = Date.parse('2026-11-23T05:00:00Z');
    const next = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'c', body: order(userId, '200.00') });
    expect(next.json.status).not.toBe('declined');
    const account = await signedFetch(mock.base, 'GET', `/v1/users/${userId}`, { token });
    expect(account.json.budget).toMatchObject({
      used: '200.00',
      period_started_at: '2026-11-23T05:00:00.000Z',
      resets_at: '2026-12-23T05:00:00.000Z',
    });
  });

  it('declines a first order under $5.00, and takes it at $5.00', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const small = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'a', body: order(userId, '4.99') });
    expect(small.status).toBe(422);
    expect(small.json).toMatchObject({
      status: 'declined',
      reason: 'amount_invalid',
      message: 'The first order for this user must be at least $5.00. Later orders can be any amount.',
    });
    const enough = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'b', body: order(userId, '5.00') });
    expect(enough.json.status).toBe('ready');
  });

  it('cancel returns the card money to the balance; GET shows cancelled', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const placed = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    const cancelled = await signedFetch(mock.base, 'POST', `/v1/checkout/orders/${placed.json.order_id}/cancel`, { token });
    expect(cancelled.json).toEqual({ status: 'cancelled', amount_returned: centsToApiAmount(quote(2000).loadCents) });
    expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${placed.json.order_id}`)).json).toEqual({
      order_id: placed.json.order_id,
      one_time: true,
      status: 'cancelled',
      amount_returned: centsToApiAmount(quote(2000).loadCents),
    });
    expect((await signedFetch(mock.base, 'POST', `/v1/checkout/orders/${placed.json.order_id}/cancel`, { token })).status).toBe(409);
  });

  it('a revoked grant gives 202 connection_required on orders and 401 elsewhere; reconnecting resumes the order', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    await fetch(`${mock.base}/mock/control/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    });
    expect((await signedFetch(mock.base, 'GET', `/v1/users/${userId}`, { token })).status).toBe(401);
    const placed = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    expect(placed.status).toBe(202);
    expect(placed.json).toEqual({
      order_id: expect.any(String),
      one_time: true,
      status: 'connection_required',
      connection_id: expect.stringMatching(/^lg_/),
      connect_url: expect.stringContaining('/v1/frames/setup?session=fs_'),
      client_secret: expect.any(String),
    });
    await finishSetup(mock.base, placed.json.connect_url);
    const connection = await signedFetch(mock.base, 'GET', `/v1/connections/${placed.json.connection_id}`);
    expect(connection.json.user_access_token).toMatch(/^ptk_test_/);
    expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${placed.json.order_id}`)).json.status).toBe('ready');
  });

  it('an unknown token is 401', async () => {
    const { userId } = await linkedUser();
    const placed = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', {
      token: 'ptk_test_unknown_token',
      idem: 'k',
      body: order(userId, '1.00'),
    });
    expect(placed.status).toBe(401);
  });

  it('the mock merchant spends the card once and the order completes with the leftover returned', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const placed = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    const card = ((await (await revealFetch(placed.json.reveal_url, token)).json()) as { data: Record<string, string> }).data;
    const pay = (amount: string) =>
      fetch(`${mock.base}/mock-merchant/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_number: card.card_number, cvv: card.cvv, exp_month: card.exp_month, exp_year: card.exp_year, amount }),
      });
    expect((await pay('25.00')).status).toBe(402);
    expect((await pay('18.00')).status).toBe(200);
    expect((await pay('1.00')).status).toBe(402);
    const done = await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${placed.json.order_id}`);
    expect(done.json).toMatchObject({ status: 'completed', amount_spent: '18.00' });
  });
});

describe('frames', () => {
  it('pages allow embedding only by the partner origin and carry no inline script', async () => {
    const created = await signedFetch(mock.base, 'POST', '/v1/users', {
      body: { external_user_id: 'ext-1', email: 'ada@example.com' },
    });
    const page = await fetch(created.json.connect_url);
    expect(page.headers.get('content-security-policy')).toContain('frame-ancestors https://localhost:5174');
    const html = await page.text();
    expect(html).toContain(`data-connection-id="${created.json.connection_id}"`);
    expect(html).not.toContain('data-login-id');
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });

  it('a budget of at least $5.00 and how often it starts again must be chosen', async () => {
    const created = await signedFetch(mock.base, 'POST', '/v1/users', {
      body: { external_user_id: 'ext-1', email: 'ada@example.com' },
    });
    await frameCall(mock.base, created.json.connect_url, 'login', { privy_access_token: 'mock-otp:123456' });
    for (const body of [
      {},
      { budget: 499, resets_every: { count: 1, unit: 'month' } },
      { budget: '100.00', resets_every: { count: 1, unit: 'month' } },
      { budget: 10000, resets_every: { count: 1, unit: 'week' } },
      { budget: 10000, resets_every: { count: 13, unit: 'month' } },
      { budget: 10000, resets_every: { count: 25, unit: 'hour' } },
      { budget: 10000, resets_every: { count: 0, unit: 'day' } },
      { budget: 10000, resets_every: { count: 1, unit: 'month' }, per_order: '5.00' },
    ]) {
      const refused = await frameCall(mock.base, created.json.connect_url, 'limits', body);
      expect(refused.status).toBe(400);
      expect(refused.json.error.code).toBe('limits_invalid');
    }
    const saved = await frameCall(mock.base, created.json.connect_url, 'limits', { budget: 500, resets_every: { count: 31, unit: 'day' } });
    expect(saved.json).toMatchObject({ limits: { budget: '5.00', resets_every: { count: 31, unit: 'day' } } });
  });
});

describe('add money pages: one amount each, opened in their own tab', () => {
  it('a top-up needs an amount: 422 amount_required, in plain words', async () => {
    const { token, userId } = await linkedUser();
    for (const options of [{ token, body: {} }, { token }]) {
      const answer = await signedFetch(mock.base, 'POST', `/v1/users/${userId}/top-ups`, options);
      expect(answer.status).toBe(422);
      expect(answer.json).toEqual({ error: { code: 'amount_required', message: 'Say how much money to add.' } });
    }
  });

  it('answers the amount, and its page refuses to be framed by anyone', async () => {
    const { token, userId } = await linkedUser();
    const link = await signedFetch(mock.base, 'POST', `/v1/users/${userId}/top-ups`, { token, body: { amount: '25.00' } });
    expect(link.status).toBe(201);
    expect(link.json).toMatchObject({ amount: '25.00', top_up_id: expect.stringMatching(/^tu_/) });
    const page = await fetch(link.json.frame_url);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('content-security-policy')).not.toContain('https://localhost:5174');
    // Connect and limits pages are still placed in the partner's page.
    const limits = await signedFetch(mock.base, 'POST', `/v1/users/${userId}/limits-link`, { token });
    expect((await fetch(limits.json.frame_url)).headers.get('content-security-policy')).toContain('frame-ancestors https://localhost:5174');
  });

  it('opens straight on the payment for its own amount: no amount can be typed there', async () => {
    const { token, userId } = await linkedUser();
    const link = await signedFetch(mock.base, 'POST', `/v1/users/${userId}/top-ups`, { token, body: { amount: '25.00' } });
    expect((await frameCall(mock.base, link.json.frame_url, 'state')).json).toMatchObject({ purpose: 'top-up', amount: '25.00' });
    expect((await frameCall(mock.base, link.json.frame_url, 'top-up', { amount: '5.00' })).status).toBe(400);
    const started = await frameCall(mock.base, link.json.frame_url, 'top-up', {});
    expect(started.status).toBe(201);
    expect(started.json.amount).toBe('25.00');
  });

  it('cancel: the payment cannot be made after it, and a payment already made is not undone', async () => {
    const { token, userId } = await linkedUser();
    const open = async () =>
      (await signedFetch(mock.base, 'POST', `/v1/users/${userId}/top-ups`, { token, body: { amount: '25.00' } })).json.frame_url as string;
    const pay = (clientSecret: string) =>
      fetch(`${mock.base}/mock-stripe/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_secret: clientSecret }),
      });

    const first = await open();
    const started = await frameCall(mock.base, first, 'top-up', {});
    expect((await frameCall(mock.base, first, 'top-up/cancel', {})).json).toEqual({ status: 'cancelled' });
    expect((await pay(started.json.client_secret as string)).status).toBe(409);
    expect((await frameCall(mock.base, first, 'top-up', {})).status).toBe(409);

    const second = await open();
    await payInFrame(mock.base, second, '25.00');
    expect((await frameCall(mock.base, second, 'top-up/cancel', {})).json).toEqual({ status: 'paid' });
    const account = await signedFetch(mock.base, 'GET', `/v1/users/${userId}`, { token });
    expect(account.json.balance.amount).toBe('25.00');
  });

  it('the page tells the window that opened it, as well as a page it is placed in', async () => {
    const script = await (await fetch(`${mock.base}/mock-assets/frame.js`)).text();
    expect(script).toContain('window.opener');
    expect(script).toContain('window.parent');
  });
});

describe('replays and frame sessions (bapi final behaviour)', () => {
  it('an order replay drops the ID check link and adds a message; GET has the link', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '400.00');
    const first = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '250.00') });
    expect(first.json.kyc_url).toContain('/mock/kyc?ref=');
    const replay = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '250.00') });
    expect(replay.status).toBe(202);
    expect(replay.json).toEqual({
      order_id: first.json.order_id,
      one_time: true,
      status: 'identity_check_required',
      message: expect.any(String),
    });
    expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${first.json.order_id}`)).json.kyc_url).toBe(first.json.kyc_url);
  });

  it('a ready replay carries no reveal link', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const first = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    expect(first.json.reveal_url).toBeDefined();
    const replay = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    expect(replay.status).toBe(201);
    expect(replay.json).not.toHaveProperty('reveal_url');
    expect(replay.json).toMatchObject({ status: 'ready', last4: first.json.last4 });
  });

  it('a card-reveal replay answers 201 with only a message; a new key gets a fresh link', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const placed = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    const path = `/v1/checkout/orders/${placed.json.order_id}/card-reveal`;
    expect((await signedFetch(mock.base, 'POST', path, { token, idem: 'r1' })).json.reveal_url).toBeDefined();
    const replay = await signedFetch(mock.base, 'POST', path, { token, idem: 'r1' });
    expect(replay.status).toBe(201);
    expect(replay.json).toEqual({ message: expect.any(String) });
    expect((await signedFetch(mock.base, 'POST', path, { token, idem: 'r2' })).json.reveal_url).toBeDefined();
  });

  it('a POST /users replay never carries a token', async () => {
    const { userId } = await linkedUser();
    const first = await signedFetch(mock.base, 'POST', '/v1/users', {
      idem: 'u1',
      body: { external_user_id: 'ext-1', reissue: true },
    });
    expect(first.json.user_access_token).toMatch(/^ptk_test_/);
    const replay = await signedFetch(mock.base, 'POST', '/v1/users', {
      idem: 'u1',
      body: { external_user_id: 'ext-1', reissue: true },
    });
    expect(replay).toEqual({ status: 200, json: { status: 'approved', user_id: userId } });
  });

  it('frame actions take the session in X-Perflo-Frame-Session, not in the path', async () => {
    const created = await signedFetch(mock.base, 'POST', '/v1/users', {
      body: { external_user_id: 'ext-1', email: 'ada@example.com' },
    });
    const session = new URL(created.json.connect_url).searchParams.get('session') as string;
    expect(session).toMatch(/^fs_[A-Za-z0-9_-]{43}$/);
    expect((await fetch(`${mock.base}/v1/frames/${session}/state`)).status).not.toBe(200);
    expect((await fetch(`${mock.base}/v1/frames/session/state`)).status).toBe(404);
    const ok = await fetch(`${mock.base}/v1/frames/session/state`, { headers: { 'X-Perflo-Frame-Session': session } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ purpose: 'setup', step: 'login' });
  });
});

describe('reuse mode (a partner whose cards serve every order for their 12 hours)', () => {
  beforeEach(async () => {
    await mock.close();
    mock = await startMock(50, undefined, true);
  });

  const balanceOf = async (userId: string, token: string) =>
    (await signedFetch(mock.base, 'GET', `/v1/users/${userId}`, { token })).json.balance.amount as string;

  it('later orders get the same card and pay no second card fee', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const first = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    const second = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k2', body: order(userId, '10.00') });
    expect(first.json.status).toBe('ready');
    expect(first.json.one_time).toBe(false);
    expect(second.json).toMatchObject({
      one_time: false,
      status: 'ready',
      card_id: first.json.card_id,
      last4: first.json.last4,
      card_expires_at: first.json.card_expires_at,
      card_limit: '10.00',
    });
    expect(await balanceOf(userId, token)).toBe(centsToApiAmount(10_000 - quote(2000).totalCents - quote(1000).loadCents));
    const account = await signedFetch(mock.base, 'GET', `/v1/users/${userId}`, { token });
    const openCards = account.json.open_cards as Array<{ card_id: string; last4: string; expires_at: string }>;
    expect(openCards.map((c) => [c.card_id, c.last4, c.expires_at])).toEqual([
      [first.json.card_id, first.json.last4, first.json.card_expires_at],
      [first.json.card_id, first.json.last4, first.json.card_expires_at],
    ]);
  });

  it('cancelling one order returns its money and leaves the card open for the other', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const first = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    const second = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k2', body: order(userId, '10.00') });
    const cancelled = await signedFetch(mock.base, 'POST', `/v1/checkout/orders/${first.json.order_id}/cancel`, { token });
    // Like bapi: the card is still open, so what went back is final only once it closes.
    expect(cancelled.json).toEqual({ status: 'cancelled', amount_returned: null });
    expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${first.json.order_id}`)).json.amount_returned).toBeNull();
    expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${second.json.order_id}`)).json.status).toBe('ready');
    const link = await signedFetch(mock.base, 'POST', `/v1/checkout/orders/${second.json.order_id}/card-reveal`, { token, idem: 'r1' });
    expect((await revealFetch(link.json.reveal_url, token)).status).toBe(200);
    const third = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k3', body: order(userId, '5.00') });
    expect(third.json.card_id).toBe(first.json.card_id);
  });

  it('a charge pays the oldest open order; the money stays on the card until it closes at its 12 hours', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const first = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    const second = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k2', body: order(userId, '10.00') });
    // The card is read through the second order: it is the same card, and the charge pays the first.
    const card = ((await (await revealFetch(second.json.reveal_url, token)).json()) as { data: Record<string, string> }).data;
    const paid = await fetch(`${mock.base}/mock-merchant/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        card_number: card.card_number,
        cvv: card.cvv,
        exp_month: card.exp_month,
        exp_year: card.exp_year,
        amount: '18.00',
      }),
    });
    expect(paid.status).toBe(200);
    expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${first.json.order_id}`)).json).toMatchObject({
      status: 'completed',
      amount_spent: '18.00',
      amount_returned: null,
    });
    expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${second.json.order_id}`)).json.status).toBe('ready');
    const before = apiAmountToCents(await balanceOf(userId, token));

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 12 * 60 * 60_000 + 1000);
      expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${second.json.order_id}`)).json.status).toBe('expired');
      const used = Math.ceil((1800 * 1033) / 1000) + 25;
      const leftover = quote(2000).loadCents - used;
      expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${first.json.order_id}`)).json.amount_returned).toBe(
        centsToApiAmount(leftover),
      );
      expect(apiAmountToCents(await balanceOf(userId, token))).toBe(before + quote(1000).loadCents + leftover);
      // A new order after the close gets a new card.
      const third = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k3', body: order(userId, '5.00') });
      expect(third.json.status).toBe('ready');
      expect(third.json.card_id).not.toBe(first.json.card_id);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reuse mode: the card closing', () => {
  let collector: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((done) => (collector ? collector.close(() => done()) : done()));
    collector = null;
  });

  it('announces card.closed once, with every order of the card newest first and its final figures', async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    collector = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        events.push(JSON.parse(raw) as { type: string; data: unknown });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((done) => (collector as Server).listen(0, '127.0.0.1', done));
    const address = collector.address() as AddressInfo;
    await mock.close();
    mock = await startMock(50, { url: `http://127.0.0.1:${address.port}/webhooks/perflo`, secret: WEBHOOK_SECRET }, true);

    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const first = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    const second = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k2', body: order(userId, '10.00') });
    await signedFetch(mock.base, 'POST', `/v1/checkout/orders/${first.json.order_id}/cancel`, { token });
    const closed = () => events.filter((e) => e.type === 'card.closed');

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 12 * 60 * 60_000 + 1000);
      await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${second.json.order_id}`);
      for (let i = 0; i < 100 && closed().length === 0; i++) await wait(20);
      await wait(600);
    } finally {
      vi.useRealTimers();
    }
    expect(closed()).toHaveLength(1);
    expect(closed()[0].data).toEqual({
      card_id: first.json.card_id,
      last4: first.json.last4,
      card_expires_at: first.json.card_expires_at,
      closed_at: expect.any(String),
      orders: [
        {
          order_id: second.json.order_id,
          status: 'expired',
          amount_spent: '0.00',
          amount_returned: centsToApiAmount(quote(1000).loadCents),
        },
        {
          order_id: first.json.order_id,
          status: 'cancelled',
          amount_spent: '0.00',
          amount_returned: centsToApiAmount(quote(2000).loadCents),
        },
      ],
    });
    expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${first.json.order_id}`)).json.amount_returned).toBe(
      centsToApiAmount(quote(2000).loadCents),
    );
  });
});

describe('reuse mode: a charge larger than the oldest open order', () => {
  beforeEach(async () => {
    await mock.close();
    mock = await startMock(50, undefined, true);
  });

  it('may use the money of every open order on the card, oldest first, and the order it reached is not cancellable', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '200.00');
    const first = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    const second = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k2', body: order(userId, '50.00') });
    const card = ((await (await revealFetch(second.json.reveal_url, token)).json()) as { data: Record<string, string> }).data;
    const pay = (amount: string) =>
      fetch(`${mock.base}/mock-merchant/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_number: card.card_number, cvv: card.cvv, exp_month: card.exp_month, exp_year: card.exp_year, amount }),
      });
    // More than both orders put on the card together.
    expect((await pay('71.00')).status).toBe(402);
    expect((await pay('50.00')).status).toBe(200);
    expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${first.json.order_id}`)).json).toMatchObject({
      status: 'completed',
      amount_spent: '50.00',
    });
    expect((await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${second.json.order_id}`)).json.status).toBe('ready');
    expect((await signedFetch(mock.base, 'POST', `/v1/checkout/orders/${second.json.order_id}/cancel`, { token })).status).toBe(409);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 12 * 60 * 60_000 + 1000);
      // At the close, what the charge left of both orders' money comes back, and the order it reached completes.
      const used = Math.ceil((5000 * 1033) / 1000) + 25;
      const left = quote(2000).loadCents + quote(5000).loadCents - used;
      const returned = await Promise.all(
        [first, second].map(
          async (o) =>
            (await signedFetch(mock.base, 'GET', `/v1/checkout/orders/${o.json.order_id}`)).json as {
              status: string;
              amount_returned: string;
            },
        ),
      );
      expect(returned.map((o) => o.status)).toEqual(['completed', 'completed']);
      expect(returned.reduce((sum, o) => sum + apiAmountToCents(o.amount_returned), 0)).toBe(left);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('one-time mode (the default)', () => {
  it('every order gets its own card', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const first = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    const second = await signedFetch(mock.base, 'POST', '/v1/checkout/orders', { token, idem: 'k2', body: order(userId, '10.00') });
    expect(second.json.card_id).not.toBe(first.json.card_id);
    expect([first.json.one_time, second.json.one_time]).toEqual([true, true]);
  });
});

describe('connections: only the connect names', () => {
  it('an order waiting on a connection, and its order.connection_required webhook, carry connection_id and connect_url only', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const hooked = await startMock(50, {
      url: 'https://tiny.test/webhooks/perflo',
      secret: WEBHOOK_SECRET,
      fetchImpl: async (_input, init) => {
        events.push(JSON.parse(String(Buffer.from(init?.body as Uint8Array))));
        return new Response(null, { status: 200 });
      },
    });
    try {
      const created = await signedFetch(hooked.base, 'POST', '/v1/users', { body: { external_user_id: 'ext-1' } });
      await finishSetup(hooked.base, created.json.connect_url);
      const linked = await signedFetch(hooked.base, 'GET', `/v1/connections/${created.json.connection_id}`);
      await fetch(`${hooked.base}/mock/control/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: linked.json.user_id }),
      });
      const placed = await signedFetch(hooked.base, 'POST', '/v1/checkout/orders', {
        token: linked.json.user_access_token,
        idem: 'k1',
        body: order(linked.json.user_id, '20.00'),
      });
      expect(placed.json).toMatchObject({ status: 'connection_required', connection_id: expect.stringMatching(/^lg_/) });
      const read = await signedFetch(hooked.base, 'GET', `/v1/checkout/orders/${placed.json.order_id}`);
      expect(read.json).toEqual(placed.json);
      await vi.waitFor(() => expect(events.some((e) => e.type === 'order.connection_required')).toBe(true));
      expect(events.some((e) => e.type.includes('login'))).toBe(false);
      const announced = events.find((e) => e.type === 'order.connection_required') as (typeof events)[number];
      expect(announced.data).toMatchObject({
        order_id: placed.json.order_id,
        status: 'connection_required',
        connection_id: placed.json.connection_id,
        connect_url: placed.json.connect_url,
      });
      expect(announced.data).not.toHaveProperty('login_id');
      expect(announced.data).not.toHaveProperty('login_url');
    } finally {
      await hooked.close();
    }
  });

  it('the connect page names the connection in perflo:connection_completed, perflo:limits_saved and perflo:setup_completed', async () => {
    const created = await signedFetch(mock.base, 'POST', '/v1/users', { body: { external_user_id: 'ext-1' } });
    const html = await (await fetch(created.json.connect_url)).text();
    expect(html).toContain(`data-connection-id="${created.json.connection_id}"`);
    const script = await (await fetch(`${mock.base}/mock-assets/frame.js`)).text();
    expect(script).toContain("send('perflo:connection_completed', { connection_id: ids.connection_id })");
    expect(script).toContain("send('perflo:limits_saved', { connection_id: ids.connection_id })");
    expect(script).toContain("send('perflo:setup_completed', { connection_id: ids.connection_id })");
    expect(script).not.toMatch(/login_completed|login_id/);
  });
});
