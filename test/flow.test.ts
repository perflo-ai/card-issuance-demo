import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoApp } from '../server/app.js';
import { quote } from '../server/mock/mockPerflo.js';
import { centsToApiAmount } from '../server/money.js';
import type { OrderView } from '../server/views.js';
import { finishSetup, makeDemo, payInFrame, startMock, wait } from './helpers.js';

let mock: { base: string; close: () => Promise<void> };
beforeEach(async () => {
  mock = await startMock(50);
});
afterEach(async () => {
  await mock.close();
});

/** A browser: the session cookie is Secure, so it is carried by hand over the test's plain HTTP. */
function browser(demo: ReturnType<typeof makeDemo>) {
  const app = createDemoApp({ config: demo.config, store: demo.store, service: demo.service, log: demo.log });
  let cookie = '';
  const keep = (res: request.Response) => {
    const set = res.headers['set-cookie'] as unknown as string[] | undefined;
    if (set?.length) cookie = set[0].split(';')[0];
    return res;
  };
  // Like a real browser on Tiny's page: one host, and its own origin on every POST.
  const host = 'tiny.test';
  return {
    post: async (path: string, body: unknown = {}) =>
      keep(await request(app).post(path).set('Host', host).set('Origin', `https://${host}`).set('Cookie', cookie).send(body as object)),
    get: async (path: string) => keep(await request(app).get(path).set('Host', host).set('Cookie', cookie)),
    cookie: () => cookie,
    raw: app,
  };
}

/** A first visit: the browser gets an anonymous Tiny account. No name or email is asked for. */
async function signUp(b: ReturnType<typeof browser>) {
  const res = await b.post('/demo/session');
  expect(res.status).toBe(200);
  return res.body.user;
}

async function ask(b: ReturnType<typeof browser>, text: string): Promise<OrderView> {
  const res = await b.post('/demo/chat', { text });
  expect(res.status).toBe(200);
  return res.body.order;
}

async function advance(b: ReturnType<typeof browser>, id: string): Promise<OrderView> {
  const res = await b.post(`/demo/orders/${id}/advance`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.order;
}

/** Setup through the frame, then the frame event the browser forwards. */
async function setUp(b: ReturnType<typeof browser>, frameUrl: string) {
  await finishSetup(mock.base, frameUrl);
  const event = await b.post('/demo/frame-events', { type: 'perflo:setup_completed', frame_session_id: new URL(frameUrl).searchParams.get('session') });
  expect(event.body).toEqual({ link: 'linked' });
}

async function addMoney(b: ReturnType<typeof browser>, amount: string) {
  const link = await b.post('/demo/top-ups', { amount });
  expect(link.status).toBe(200);
  await payInFrame(mock.base, link.body.frameUrl, amount);
}

function assertNothingSecretLeaks(demo: ReturnType<typeof makeDemo>, ...browserBodies: unknown[]) {
  const store = JSON.parse(readFileSync(demo.dataFile, 'utf8'));
  const tokens = Object.values(store.users as Record<string, { perflo: { token: string } | null }>)
    .map((u) => u.perflo?.token)
    .filter(Boolean) as string[];
  const userId = Object.keys(store.users)[0];
  const exposed = JSON.stringify([...browserBodies, demo.log.forUser(userId)]);
  for (const token of tokens) expect(exposed).not.toContain(token);
  expect(exposed).not.toMatch(/ptk_test_/);
  expect(exposed).not.toMatch(/sensitive\?t=/);
  expect(exposed).not.toMatch(/"card_number":"[0-9]/);
  expect(exposed).not.toMatch(/[0-9]{16}/);
  // The stored order never keeps the single-use reveal link.
  expect(JSON.stringify(store.orders)).not.toContain('reveal_url');
}

describe('first order, end to end in mock mode', () => {
  it('setup, add money, card, checkout, done; no token or card number reaches the browser or the log', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await signUp(b);
    const draft = await ask(b, 'buy me $50 worth of headphones on amazon');
    expect(draft).toMatchObject({ phase: 'draft', domain: 'amazon.com', amountCents: 5000, description: 'headphones' });

    const setup = await advance(b, draft.id);
    expect(setup.phase).toBe('needs_setup');
    expect(setup.frameUrl).toContain(`${mock.base}/partner/v2/frames/setup?session=`);

    // While the frame is still on the limits step, the login is pending.
    const loginEvent = await b.post('/demo/frame-events', { type: 'perflo:login_completed', frame_session_id: 'fs_x' });
    expect(loginEvent.body).toEqual({ link: 'pending' });
    await setUp(b, setup.frameUrl as string);

    const due = await advance(b, draft.id);
    expect(due).toMatchObject({ phase: 'payment_required', amountDue: '52.90' });
    await payInFrame(mock.base, due.frameUrl as string, due.amountDue as string);

    const done = await advance(b, draft.id);
    expect(done).toMatchObject({ phase: 'completed', amountSpent: '50.00' });
    expect(done.checkout).toMatchObject({ last4: expect.stringMatching(/^[0-9]{4}$/), outcome: 'charged', cardLimit: '50.00' });
    expect(Object.keys(done.checkout as object).sort()).toEqual(['cardLimit', 'expMonth', 'expYear', 'filledAt', 'last4', 'outcome']);

    const account = await b.get('/demo/account');
    expect(account.body).toMatchObject({ linked: true, account: { limits: { spent_this_month: { amount: '50.00', currency: 'USD' } } } });
    const events = await b.get('/demo/events');
    assertNothingSecretLeaks(demo, setup, due, done, account.body, events.body);
  });

  it('retrying a placed order never places a second one', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await signUp(b);
    const draft = await ask(b, 'buy me $50 worth of headphones on amazon');
    await setUp(b, (await advance(b, draft.id)).frameUrl as string);
    const first = await advance(b, draft.id);
    const again = await advance(b, draft.id);
    expect(again.perfloOrderId).toBe(first.perfloOrderId);
    const posts = demo.log.forUser(demo.store.ordersFor(Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0])[0].demoUserId)
      .filter((e) => e.summary.startsWith('POST /partner/v2/orders ->'));
    expect(posts).toHaveLength(1);
  });
});

describe('anonymous sessions and connecting first', () => {
  it('a first visit makes an anonymous account; the same browser keeps it', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    expect(await signUp(b)).toEqual({ linked: false, stopAtCheckout: false });
    expect(await signUp(b)).toEqual({ linked: false, stopAtCheckout: false });
    const store = JSON.parse(readFileSync(demo.dataFile, 'utf8'));
    expect(Object.keys(store.users)).toHaveLength(1);
    expect(Object.keys(Object.values(store.users)[0] as object).sort()).toEqual(['createdAt', 'id', 'pendingLogin', 'perflo']);
  });

  it('connects before any order: POST /users carries no email or name, the frame asks for the email', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await signUp(b);
    const start = await b.post('/demo/link/start');
    expect(start.body).toMatchObject({ link: 'login_required', frameUrl: expect.stringContaining('/partner/v2/frames/setup?session=') });
    // Asking again while the link is still open reuses it: one read of the login, no second POST /users.
    const again = await b.post('/demo/link/start');
    expect(again.body.frameUrl).toBe(start.body.frameUrl);
    await setUp(b, start.body.frameUrl);
    expect((await b.post('/demo/session')).body.user.linked).toBe(true);
    expect((await b.post('/demo/link/start')).body).toEqual({ link: 'linked' });

    const userId = Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0];
    const posts = demo.log.forUser(userId).filter((e) => e.summary.startsWith('POST /partner/v2/users'));
    expect(posts).toHaveLength(1);
    expect((posts[0].detail as { request: unknown }).request).toEqual({ external_user_id: userId });

    // Then the first order goes straight to payments.
    const draft = await ask(b, 'buy me $5 worth of stickers on amazon');
    expect((await advance(b, draft.id)).phase).toBe('payment_required');
  });

  it('a setup link that expired is replaced on the next start', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await signUp(b);
    const first = (await b.post('/demo/link/start')).body.frameUrl as string;
    // Half an hour later the login has expired: the start looks first, then asks for a new one.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31 * 60_000 });
    try {
      const next = await b.post('/demo/link/start');
      expect(next.body.link).toBe('login_required');
      expect(next.body.frameUrl).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('every new browser is a different person with no payments link', async () => {
    const demo = makeDemo(mock.base);
    const owner = browser(demo);
    await signUp(owner);
    const draft = await ask(owner, 'buy me $5 worth of stickers on amazon');
    await setUp(owner, (await advance(owner, draft.id)).frameUrl as string);
    expect((await owner.post('/demo/session')).body.user.linked).toBe(true);

    const stranger = browser(demo);
    const second = await signUp(stranger);
    expect(second.linked).toBe(false);
    const store = JSON.parse(readFileSync(demo.dataFile, 'utf8'));
    const users = Object.values(store.users) as Array<{ id: string; perflo: unknown }>;
    expect(users).toHaveLength(2);
    expect(users[0].id).not.toBe(users[1].id);
    expect(users.filter((u) => u.perflo !== null)).toHaveLength(1);

    // The stranger cannot see the owner's orders or balance, and must prove the email to Perflo.
    expect((await stranger.get('/demo/orders')).body.orders).toEqual([]);
    expect((await stranger.get('/demo/account')).body).toEqual({ linked: false });
    const theirs = await ask(stranger, 'buy me $5 worth of stickers on amazon');
    expect((await advance(stranger, theirs.id)).phase).toBe('needs_setup');
  });
});

describe('other order states through the demo', () => {
  async function linkedWithMoney(b: ReturnType<typeof browser>, amount: string) {
    await signUp(b);
    const draft = await ask(b, 'buy me $1.00 worth of gum on amazon');
    await setUp(b, (await advance(b, draft.id)).frameUrl as string);
    await addMoney(b, amount);
    return draft;
  }

  it('issuing, then ready on a later look', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await linkedWithMoney(b, '200.00');
    const draft = await ask(b, 'book the 150.00 hotel on united.com');
    expect((await advance(b, draft.id)).phase).toBe('issuing');
    await wait(80);
    expect((await advance(b, draft.id)).phase).toBe('completed');
  });

  it('watching a card get ready logs each status once, however many looks it took', async () => {
    const slow = await startMock(400);
    try {
      const demo = makeDemo(slow.base);
      const b = browser(demo);
      await signUp(b);
      const start = await b.post('/demo/link/start');
      await finishSetup(slow.base, start.body.frameUrl);
      await b.post('/demo/frame-events', { type: 'perflo:setup_completed', frame_session_id: new URL(start.body.frameUrl).searchParams.get('session') });
      const link = await b.post('/demo/top-ups', { amount: '200.00' });
      await payInFrame(slow.base, link.body.frameUrl, '200.00');
      const draft = await ask(b, 'book the 150.00 hotel on united.com');
      expect((await advance(b, draft.id)).phase).toBe('issuing');
      let looks = 0;
      let phase = 'issuing';
      while (phase === 'issuing') {
        await wait(60);
        phase = (await advance(b, draft.id)).phase;
        looks++;
      }
      expect(phase).toBe('completed');
      expect(looks).toBeGreaterThan(2);
      const userId = Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0];
      const reads = demo.log.forUser(userId).filter((e) => e.summary.startsWith('GET /partner/v2/orders/'));
      expect(reads.map((e) => e.summary.replace(/ord_[A-Za-z0-9_-]+/, 'ID'))).toEqual([
        'GET /partner/v2/orders/ID -> 200 issuing',
        'GET /partner/v2/orders/ID -> 200 ready',
        'GET /partner/v2/orders/ID -> 200 completed',
      ]);
    } finally {
      await slow.close();
    }
  });

  it('identity check, then the order continues', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await linkedWithMoney(b, '400.00');
    const draft = await ask(b, 'book the 250.00 flight on united.com');
    const waiting = await advance(b, draft.id);
    expect(waiting.phase).toBe('identity_check_required');
    const ref = new URL(waiting.kycUrl as string).searchParams.get('ref') as string;
    await fetch(`${mock.base}/mock/kyc`, { method: 'POST', body: new URLSearchParams({ ref }) });
    const next = await advance(b, draft.id);
    expect(['issuing', 'completed']).toContain(next.phase);
  });

  it('declined in plain words', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await linkedWithMoney(b, '10.00');
    const draft = await ask(b, 'buy me $2600 worth of chairs on amazon');
    expect(await advance(b, draft.id)).toMatchObject({
      phase: 'declined',
      declineReason: 'amount_invalid',
      declineMessage: 'Cards can be up to $2,500 each.',
    });
  });

  it('stop at checkout keeps the card open, and Cancel card returns the money', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await linkedWithMoney(b, '100.00');
    expect((await b.post('/demo/mock/stop-at-checkout', { on: true })).body.user.stopAtCheckout).toBe(true);
    const draft = await ask(b, 'buy me $20 worth of books on amazon');
    const ready = await advance(b, draft.id);
    expect(ready).toMatchObject({ phase: 'ready', checkout: { outcome: 'filled_not_submitted' } });
    const account = await b.get('/demo/account');
    expect(account.body.account.open_cards).toHaveLength(1);
    const cancelled = await b.post(`/demo/cards/${ready.perfloOrderId}/cancel`);
    const load = centsToApiAmount(quote(2000).loadCents);
    expect(cancelled.body).toMatchObject({ amountReturned: load, order: { phase: 'cancelled', amountReturned: load } });
  });

  it('shows an open card on request: read fresh each time, never stored or logged, only to its owner', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await linkedWithMoney(b, '100.00');
    await b.post('/demo/mock/stop-at-checkout', { on: true });
    const ready = await advance(b, (await ask(b, 'buy me $20 worth of books on amazon')).id);
    expect(ready.phase).toBe('ready');
    const path = `/demo/orders/${ready.perfloOrderId}/card-details`;

    const first = await b.post(path);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.headers['cache-control']).toContain('no-store');
    expect(first.body.card).toMatchObject({
      number: expect.stringMatching(/^[0-9]{12,19}$/),
      cvv: expect.stringMatching(/^[0-9]{3,4}$/),
      expMonth: expect.stringMatching(/^[0-9]{2}$/),
      expYear: expect.stringMatching(/^[0-9]{4}$/),
      last4: ready.checkout?.last4,
    });
    expect(first.body.card.number.endsWith(first.body.card.last4)).toBe(true);
    // A second look reads a fresh single-use link and gets the same card.
    const second = await b.post(path);
    expect(second.status).toBe(200);
    expect(second.body.card.number).toBe(first.body.card.number);

    // Never kept on disk or in the developer log.
    const number = first.body.card.number as string;
    const cvv = first.body.card.cvv as string;
    expect(readFileSync(demo.dataFile, 'utf8')).not.toContain(number);
    const logged = JSON.stringify(demo.log.forUser(Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0]));
    expect(logged).not.toContain(number);
    expect(logged).not.toMatch(new RegExp(`"cvv"|cvv[^a-z]*${cvv}`));
    expect(logged).not.toMatch(/sensitive\?t=/);

    // The orders list carries when each order was made, for the Orders tab.
    const listed = (await b.get('/demo/orders')).body.orders as OrderView[];
    expect(listed.find((o) => o.perfloOrderId === ready.perfloOrderId)?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Another person cannot read it.
    const other = browser(demo);
    await signUp(other);
    expect((await other.post(path)).status).toBe(404);

    // A closed card has nothing to show.
    await b.post(`/demo/cards/${ready.perfloOrderId}/cancel`);
    const closed = await b.post(path);
    expect(closed.status).toBe(409);
    expect(closed.body.error.message).toBe('This card is closed, so there are no details to show.');
  });

  it('access turned off: the order asks to sign in again, then continues on its own', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await linkedWithMoney(b, '100.00');
    expect((await b.post('/demo/mock/revoke-access')).status).toBe(200);
    const draft = await ask(b, 'buy me $20 worth of books on amazon');
    const blocked = await advance(b, draft.id);
    expect(blocked.phase).toBe('login_required');
    expect((await b.post('/demo/session')).body.user.linked).toBe(false);
    await setUp(b, blocked.frameUrl as string);
    expect((await advance(b, draft.id)).phase).toBe('completed');
  });

  it('a lost token is replaced (approved without token, then reissue)', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await linkedWithMoney(b, '100.00');
    const userId = Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0];
    demo.store.updateUser(userId, (u) => (u.perflo = null));
    const draft = await ask(b, 'buy me $20 worth of books on amazon');
    expect((await advance(b, draft.id)).phase).toBe('completed');
    expect(demo.log.forUser(userId).some((e) => e.summary.includes('asking for a new one'))).toBe(true);
  });

  it('a refused token (401) is replaced and the same order goes through', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await linkedWithMoney(b, '100.00');
    const userId = Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0];
    demo.store.updateUser(userId, (u) => {
      if (u.perflo) u.perflo.token = 'ptk_test_not_a_real_token_value';
    });
    const draft = await ask(b, 'buy me $20 worth of books on amazon');
    expect((await advance(b, draft.id)).phase).toBe('completed');
  });
});

describe('live mode never buys', () => {
  it('fills the checkout and leaves the card open', async () => {
    const demo = makeDemo(mock.base, 'live');
    const b = browser(demo);
    await signUp(b);
    const draft = await ask(b, 'buy me $20 worth of books on amazon');
    await setUp(b, (await advance(b, draft.id)).frameUrl as string);
    await addMoney(b, '100.00');
    expect(await advance(b, draft.id)).toMatchObject({ phase: 'ready', checkout: { outcome: 'filled_not_submitted' } });
    expect((await b.post('/demo/mock/revoke-access')).status).toBe(404);
  });
});

describe('demo API guards', () => {
  it('needs a session and refuses non-JSON bodies; the old sign-up route is gone', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    expect((await b.get('/demo/orders')).status).toBe(401);
    expect((await b.post('/demo/link/start')).status).toBe(401);
    expect(
      (await request(b.raw).post('/demo/session').set('Host', 'tiny.test').set('Origin', 'https://tiny.test').set('Content-Type', 'text/plain').send('x')).status,
    ).toBe(415);
    expect((await b.post('/demo/signup', { first_name: 'A', last_name: 'B', email: 'a@example.com' })).status).toBe(404);
    expect((await b.get('/demo/me')).status).toBe(404);
    await signUp(b);
    expect((await b.post('/demo/frame-events', { type: 'perflo:something_else', frame_session_id: 'x' })).status).toBe(400);
    expect((await b.post('/demo/orders/nope/advance')).status).toBe(404);
  });
});
