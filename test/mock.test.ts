import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quote } from '../server/mock/mockPerflo.js';
import { centsToApiAmount } from '../server/money.js';
import { finishSetup, frameCall, payInFrame, revealFetch, signedFetch, startMock, wait } from './helpers.js';

let mock: { base: string; close: () => Promise<void> };
beforeEach(async () => {
  mock = await startMock(50);
});
afterEach(async () => {
  await mock.close();
});

/** A linked user with limits and a token, plus an optional balance. */
async function linkedUser(
  externalId = 'ext-1',
  email = 'ada@example.com',
  balance?: string,
  limits = { per_order: '500.00', per_month: '1000.00' },
) {
  const created = await signedFetch(mock.base, 'POST', '/partner/v2/users', { body: { external_user_id: externalId, email } });
  expect(created.status).toBe(202);
  await finishSetup(mock.base, created.json.login_url, limits);
  const login = await signedFetch(mock.base, 'GET', `/partner/v2/logins/${created.json.login_id}`);
  const token = login.json.user_access_token as string;
  const userId = login.json.user_id as string;
  if (balance) {
    const link = await signedFetch(mock.base, 'POST', `/partner/v2/users/${userId}/top-ups`, { token, body: { amount: balance } });
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
    const unsigned = await fetch(`${mock.base}/partner/v2/users`, { method: 'POST' });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({ error: { code: 'unauthorized', message: 'We could not confirm who sent this request.' } });
    const wrong = await signedFetch(mock.base, 'POST', '/partner/v2/users', { body: { external_user_id: 'x' }, secret: 'B'.repeat(43) });
    expect(wrong.status).toBe(401);
  });

  it('refuses a body that differs from the signed one', async () => {
    const { signatureHeaders } = await import('../server/signing.js');
    const { CREDS } = await import('./helpers.js');
    const signed = signatureHeaders(CREDS, 'POST', '/partner/v2/users', Buffer.from('{"external_user_id":"a"}'));
    const response = await fetch(`${mock.base}/partner/v2/users`, {
      method: 'POST',
      headers: { ...signed, 'Content-Type': 'application/json' },
      body: '{"external_user_id":"b"}',
    });
    expect(response.status).toBe(401);
  });
});

describe('users and logins', () => {
  it('login_required, then approved with the token exactly once', async () => {
    const created = await signedFetch(mock.base, 'POST', '/partner/v2/users', { body: { external_user_id: 'ext-1', email: 'ada@example.com' } });
    expect(created.status).toBe(202);
    expect(created.json).toMatchObject({ status: 'login_required', login_id: expect.stringMatching(/^lg_/) });
    expect(created.json.login_url).toContain('/partner/v2/frames/setup?session=fs_');

    expect((await signedFetch(mock.base, 'GET', `/partner/v2/logins/${created.json.login_id}`)).json).toEqual({ status: 'pending' });
    // The frame knows the email, so the code is already sent: the first step is the code.
    expect((await frameCall(mock.base, created.json.login_url, 'state')).json).toMatchObject({ purpose: 'setup', step: 'login', email_masked: 'a***@example.com' });
    await finishSetup(mock.base, created.json.login_url);

    const first = await signedFetch(mock.base, 'GET', `/partner/v2/logins/${created.json.login_id}`);
    expect(first.json).toMatchObject({ status: 'approved', user_id: expect.stringMatching(/^usr_/), user_access_token: expect.stringMatching(/^ptk_test_/) });
    const second = await signedFetch(mock.base, 'GET', `/partner/v2/logins/${created.json.login_id}`);
    expect(second.json).toEqual({ status: 'approved', user_id: first.json.user_id });
  });

  it('approved without a token for a known external id; reissue mints a new one and revokes the old', async () => {
    const { token, userId } = await linkedUser();
    const again = await signedFetch(mock.base, 'POST', '/partner/v2/users', { body: { external_user_id: 'ext-1' } });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ status: 'approved', user_id: userId });

    const reissued = await signedFetch(mock.base, 'POST', '/partner/v2/users', { body: { external_user_id: 'ext-1', reissue: true } });
    expect(reissued.json.user_access_token).toMatch(/^ptk_test_/);
    expect(reissued.json.user_access_token).not.toBe(token);
    expect((await signedFetch(mock.base, 'GET', `/partner/v2/users/${userId}`, { token })).status).toBe(401);
    expect((await signedFetch(mock.base, 'GET', `/partner/v2/users/${userId}`, { token: reissued.json.user_access_token })).status).toBe(200);
  });

  it('never grants access by email alone: a new external id must sign in', async () => {
    await linkedUser('ext-1', 'ada@example.com');
    const other = await signedFetch(mock.base, 'POST', '/partner/v2/users', { body: { external_user_id: 'ext-2', email: 'ada@example.com' } });
    expect(other.status).toBe(202);
    expect(other.json.status).toBe('login_required');
  });

  it('a wrong code is refused in plain words', async () => {
    const created = await signedFetch(mock.base, 'POST', '/partner/v2/users', { body: { external_user_id: 'ext-1', email: 'ada@example.com' } });
    const wrong = await frameCall(mock.base, created.json.login_url, 'login', { privy_access_token: 'mock-otp:000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.message).toBe('That code is not right. Check it and try again.');
  });

  it('account shape matches SPEC 4', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const account = await signedFetch(mock.base, 'GET', `/partner/v2/users/${userId}`, { token });
    expect(account.json).toEqual({
      user_id: userId,
      balance: { amount: '100.00', currency: 'USD' },
      limits: {
        per_order: { amount: '500.00', currency: 'USD' },
        per_month: { amount: '1000.00', currency: 'USD' },
        spent_this_month: { amount: '0.00', currency: 'USD' },
        remaining_this_month: { amount: '1000.00', currency: 'USD' },
      },
      identity_check: { required_above: '200.00', status: 'not_required' },
      open_cards: [],
    });
  });
});

describe('orders', () => {
  it('requires an Idempotency-Key and replays the stored answer for the same key', async () => {
    const { token, userId } = await linkedUser();
    expect((await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, body: order(userId, '10.00') })).status).toBe(400);
    const first = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '10.00') });
    const again = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '10.00') });
    expect(again).toEqual(first);
    const conflict = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '11.00') });
    expect(conflict.status).toBe(409);
  });

  it('payment_required, then ready after the money lands (retry is a GET)', async () => {
    const { token, userId } = await linkedUser();
    const placed = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '50.00') });
    expect(placed.status).toBe(202);
    expect(placed.json).toMatchObject({ status: 'payment_required', amount_due: centsToApiAmount(quote(5000).totalCents) });
    await payInFrame(mock.base, placed.json.frame_url, placed.json.amount_due);
    const now = await signedFetch(mock.base, 'GET', `/partner/v2/orders/${placed.json.order_id}`);
    expect(now.status).toBe(200);
    expect(now.json).toMatchObject({ status: 'ready', last4: expect.stringMatching(/^[0-9]{4}$/), card_limit: '50.00' });
    // GET never repeats the single-use reveal link.
    expect(now.json).not.toHaveProperty('reveal_url');
  });

  it('ready on POST carries a single-use reveal link answering the ms-card envelope', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const placed = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    expect(placed.status).toBe(201);
    expect(placed.json).toMatchObject({ status: 'ready', card_id: expect.any(String), reveal_url: expect.any(String), reveal_expires_at: expect.any(String), card_expires_at: expect.any(String) });
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
    expect(body).toMatchObject({ success: true, data: { card_number: expect.stringMatching(/^[0-9]{16}$/), cvv: expect.stringMatching(/^[0-9]{3}$/), last4: placed.json.last4 } });
    expect((await revealFetch(placed.json.reveal_url, token)).status).toBe(404);
    const fresh = await signedFetch(mock.base, 'POST', `/partner/v2/orders/${placed.json.order_id}/card-reveal`, { token });
    expect(fresh.status).toBe(201);
    expect((await revealFetch(fresh.json.reveal_url, token)).status).toBe(200);
  });

  it('issuing, then ready on GET', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '200.00');
    const placed = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '150.00') });
    expect(placed.status).toBe(202);
    expect(placed.json).toEqual({ order_id: placed.json.order_id, status: 'issuing' });
    await wait(80);
    expect((await signedFetch(mock.base, 'GET', `/partner/v2/orders/${placed.json.order_id}`)).json.status).toBe('ready');
  });

  it('identity_check_required once total card spending would pass $200, then continues after the check', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '400.00');
    const first = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '80.00') });
    expect(first.status).toBe(201);
    const second = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k2', body: order(userId, '130.00') });
    expect(second.status).toBe(202);
    expect(second.json).toMatchObject({ status: 'identity_check_required', kyc_url: expect.stringContaining('/mock/kyc?ref=') });
    const ref = new URL(second.json.kyc_url).searchParams.get('ref') as string;
    await fetch(`${mock.base}/mock/kyc`, { method: 'POST', body: new URLSearchParams({ ref }) });
    const resumed = await signedFetch(mock.base, 'GET', `/partner/v2/orders/${second.json.order_id}`);
    expect(['issuing', 'ready']).toContain(resumed.json.status);
  });

  it.each([
    ['600.00', 'over_order_limit'],
    ['2600.00', 'amount_invalid'],
    ['10.5', 'amount_invalid'],
    ['0.00', 'amount_invalid'],
  ])('declines %s with %s (422)', async (amount, reason) => {
    const { token, userId } = await linkedUser();
    const placed = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: `k-${amount}`, body: order(userId, amount) });
    expect(placed.status).toBe(422);
    expect(placed.json).toMatchObject({ order_id: expect.any(String), status: 'declined', reason, message: expect.any(String) });
    if (amount === '2600.00') expect(placed.json.message).toBe('Cards can be up to $2,500 each.');
  });

  it('declines over the monthly limit', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '1000.00', { per_order: '500.00', per_month: '600.00' });
    const first = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'a', body: order(userId, '450.00') });
    expect(first.json.status).toBe('identity_check_required');
    const ref = new URL(first.json.kyc_url).searchParams.get('ref') as string;
    await fetch(`${mock.base}/mock/kyc`, { method: 'POST', body: new URLSearchParams({ ref }) });
    expect(['issuing', 'ready']).toContain((await signedFetch(mock.base, 'GET', `/partner/v2/orders/${first.json.order_id}`)).json.status);
    const over = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'b', body: order(userId, '200.00') });
    expect(over.status).toBe(422);
    expect(over.json).toMatchObject({ status: 'declined', reason: 'over_monthly_limit' });
  });

  it('cancel returns the card money to the balance; GET shows cancelled', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const placed = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    const cancelled = await signedFetch(mock.base, 'POST', `/partner/v2/orders/${placed.json.order_id}/cancel`, { token });
    expect(cancelled.json).toEqual({ status: 'cancelled', amount_returned: centsToApiAmount(quote(2000).loadCents) });
    expect((await signedFetch(mock.base, 'GET', `/partner/v2/orders/${placed.json.order_id}`)).json).toEqual({ order_id: placed.json.order_id, status: 'cancelled' });
    expect((await signedFetch(mock.base, 'POST', `/partner/v2/orders/${placed.json.order_id}/cancel`, { token })).status).toBe(409);
  });

  it('a revoked grant gives 202 login_required on orders and 401 elsewhere; login resumes the order', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    await fetch(`${mock.base}/mock/control/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId }) });
    expect((await signedFetch(mock.base, 'GET', `/partner/v2/users/${userId}`, { token })).status).toBe(401);
    const placed = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    expect(placed.status).toBe(202);
    expect(placed.json).toMatchObject({ status: 'login_required', login_id: expect.any(String), login_url: expect.any(String) });
    await finishSetup(mock.base, placed.json.login_url);
    const login = await signedFetch(mock.base, 'GET', `/partner/v2/logins/${placed.json.login_id}`);
    expect(login.json.user_access_token).toMatch(/^ptk_test_/);
    expect((await signedFetch(mock.base, 'GET', `/partner/v2/orders/${placed.json.order_id}`)).json.status).toBe('ready');
  });

  it('an unknown token is 401', async () => {
    const { userId } = await linkedUser();
    const placed = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token: 'ptk_test_unknown_token', idem: 'k', body: order(userId, '1.00') });
    expect(placed.status).toBe(401);
  });

  it('the mock merchant spends the card once and the order completes with the leftover returned', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const placed = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '20.00') });
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
    const done = await signedFetch(mock.base, 'GET', `/partner/v2/orders/${placed.json.order_id}`);
    expect(done.json).toMatchObject({ status: 'completed', amount_spent: '18.00' });
  });
});

describe('frames', () => {
  it('pages allow embedding only by the partner origin and carry no inline script', async () => {
    const created = await signedFetch(mock.base, 'POST', '/partner/v2/users', { body: { external_user_id: 'ext-1', email: 'ada@example.com' } });
    const page = await fetch(created.json.login_url);
    expect(page.headers.get('content-security-policy')).toContain('frame-ancestors https://localhost:5174');
    const html = await page.text();
    expect(html).toContain(`data-login-id="${created.json.login_id}"`);
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });

  it('limits must be chosen and per order cannot exceed per month', async () => {
    const created = await signedFetch(mock.base, 'POST', '/partner/v2/users', { body: { external_user_id: 'ext-1', email: 'ada@example.com' } });
    await frameCall(mock.base, created.json.login_url, 'login', { privy_access_token: 'mock-otp:123456' });
    expect((await frameCall(mock.base, created.json.login_url, 'limits', {})).status).toBe(400);
    expect((await frameCall(mock.base, created.json.login_url, 'limits', { per_order: '2500.00', per_month: '1000.00' })).status).toBe(400);
  });
});

describe('replays and frame sessions (bapi final behaviour)', () => {
  it('an order replay drops the ID check link and adds a message; GET has the link', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '400.00');
    const first = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '250.00') });
    expect(first.json.kyc_url).toContain('/mock/kyc?ref=');
    const replay = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '250.00') });
    expect(replay.status).toBe(202);
    expect(replay.json).toEqual({ order_id: first.json.order_id, status: 'identity_check_required', message: expect.any(String) });
    expect((await signedFetch(mock.base, 'GET', `/partner/v2/orders/${first.json.order_id}`)).json.kyc_url).toBe(first.json.kyc_url);
  });

  it('a ready replay carries no reveal link', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const first = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    expect(first.json.reveal_url).toBeDefined();
    const replay = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    expect(replay.status).toBe(201);
    expect(replay.json).not.toHaveProperty('reveal_url');
    expect(replay.json).toMatchObject({ status: 'ready', last4: first.json.last4 });
  });

  it('a card-reveal replay answers 201 with only a message; a new key gets a fresh link', async () => {
    const { token, userId } = await linkedUser('ext-1', 'ada@example.com', '100.00');
    const placed = await signedFetch(mock.base, 'POST', '/partner/v2/orders', { token, idem: 'k1', body: order(userId, '20.00') });
    const path = `/partner/v2/orders/${placed.json.order_id}/card-reveal`;
    expect((await signedFetch(mock.base, 'POST', path, { token, idem: 'r1' })).json.reveal_url).toBeDefined();
    const replay = await signedFetch(mock.base, 'POST', path, { token, idem: 'r1' });
    expect(replay.status).toBe(201);
    expect(replay.json).toEqual({ message: expect.any(String) });
    expect((await signedFetch(mock.base, 'POST', path, { token, idem: 'r2' })).json.reveal_url).toBeDefined();
  });

  it('a POST /users replay never carries a token', async () => {
    const { userId } = await linkedUser();
    const first = await signedFetch(mock.base, 'POST', '/partner/v2/users', { idem: 'u1', body: { external_user_id: 'ext-1', reissue: true } });
    expect(first.json.user_access_token).toMatch(/^ptk_test_/);
    const replay = await signedFetch(mock.base, 'POST', '/partner/v2/users', { idem: 'u1', body: { external_user_id: 'ext-1', reissue: true } });
    expect(replay).toEqual({ status: 200, json: { status: 'approved', user_id: userId } });
  });

  it('frame actions take the session in X-Perflo-Frame-Session, not in the path', async () => {
    const created = await signedFetch(mock.base, 'POST', '/partner/v2/users', { body: { external_user_id: 'ext-1', email: 'ada@example.com' } });
    const session = new URL(created.json.login_url).searchParams.get('session') as string;
    expect(session).toMatch(/^fs_[A-Za-z0-9_-]{43}$/);
    expect((await fetch(`${mock.base}/partner/v2/frames/${session}/state`)).status).not.toBe(200);
    expect((await fetch(`${mock.base}/partner/v2/frames/session/state`)).status).toBe(404);
    const ok = await fetch(`${mock.base}/partner/v2/frames/session/state`, { headers: { 'X-Perflo-Frame-Session': session } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ purpose: 'setup', step: 'login' });
  });
});
