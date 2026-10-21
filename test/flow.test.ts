import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoApp } from '../server/app.js';
import { quote } from '../server/mock/mockPerflo.js';
import { centsToApiAmount } from '../server/money.js';
import { PerfloApiError } from '../server/perfloApi.js';
import type { MeView, OrderView } from '../server/views.js';
import { finishSetup, frameCall, makeDemo, payInFrame, startMock, wait } from './helpers.js';

let mock: { base: string; close: () => Promise<void> };
beforeEach(async () => {
  mock = await startMock(50);
});
afterEach(async () => {
  await mock.close();
});

/** A browser: the session cookie is Secure, so it is carried by hand over the test's plain HTTP. */
function browser(demo: ReturnType<typeof makeDemo>) {
  const app = createDemoApp({ config: demo.config, store: demo.store, service: demo.service, log: demo.log, logger: demo.logger });
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
      keep(
        await request(app)
          .post(path)
          .set('Host', host)
          .set('Origin', `https://${host}`)
          .set('Cookie', cookie)
          .send(body as object),
      ),
    get: async (path: string) => keep(await request(app).get(path).set('Host', host).set('Cookie', cookie)),
    cookie: () => cookie,
    raw: app,
  };
}

/** A first visit: the browser gets an anonymous Tiny account. No name or email is asked for. */
async function signUp(b: ReturnType<typeof browser>) {
  const res = await b.post('/demo/session');
  expect(res.status).toBe(200);
  return res.body.user as MeView;
}

async function ask(b: ReturnType<typeof browser>, text: string): Promise<OrderView> {
  const res = await b.post('/demo/chat', { text });
  expect(res.status).toBe(200);
  return res.body.order as OrderView;
}

async function advance(b: ReturnType<typeof browser>, id: string): Promise<OrderView> {
  const res = await b.post(`/demo/orders/${id}/advance`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.order as OrderView;
}

/** Setup through the frame, then the frame event the browser forwards. */
async function setUp(b: ReturnType<typeof browser>, frameUrl: string) {
  await finishSetup(mock.base, frameUrl);
  const event = await b.post('/demo/frame-events', {
    type: 'perflo:setup_completed',
    frame_session_id: new URL(frameUrl).searchParams.get('session'),
  });
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
    expect(setup.frameUrl).toContain(`${mock.base}/v1/frames/setup?session=`);

    // While the frame is still on the limits step, the connection is pending.
    const connectionEvent = await b.post('/demo/frame-events', { type: 'perflo:connection_completed', frame_session_id: 'fs_x' });
    expect(connectionEvent.body).toEqual({ link: 'pending' });
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
    const posts = demo.log
      .forUser(demo.store.ordersFor(Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0])[0].demoUserId)
      .filter((e) => e.summary.startsWith('POST /v1/checkout/orders ->'));
    expect(posts).toHaveLength(1);
  });
});

describe('anonymous sessions and setting up payments in the chat', () => {
  it('a first visit makes an anonymous account; the same browser keeps it', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    expect(await signUp(b)).toEqual({ linked: false, stopAtCheckout: false, look: 'brand' });
    expect(await signUp(b)).toEqual({ linked: false, stopAtCheckout: false, look: 'brand' });
    const store = JSON.parse(readFileSync(demo.dataFile, 'utf8'));
    expect(Object.keys(store.users)).toHaveLength(1);
    expect(Object.keys(Object.values(store.users)[0] as object).sort()).toEqual(['createdAt', 'id', 'pendingConnection', 'perflo']);
  });

  it('payments are set up in the chat, on the first order: POST /users carries no email or name', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await signUp(b);
    // There is no separate screen to connect from first.
    expect((await b.post('/demo/link/start')).status).toBe(404);
    const draft = await ask(b, 'buy me $5 worth of stickers on amazon');
    const setup = await advance(b, draft.id);
    expect(setup).toMatchObject({ phase: 'needs_setup', frameUrl: expect.stringContaining('/v1/frames/setup?session=') });
    // Looking again while the setup link is still open reuses it: no second POST /users.
    expect((await advance(b, draft.id)).frameUrl).toBe(setup.frameUrl);
    await setUp(b, setup.frameUrl as string);
    expect((await b.post('/demo/session')).body.user.linked).toBe(true);

    const userId = Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0];
    const posts = demo.log.forUser(userId).filter((e) => e.summary.startsWith('POST /v1/users'));
    expect(posts).toHaveLength(1);
    expect((posts[0].detail as { request: unknown }).request).toEqual({ external_user_id: userId });

    // Then the same order goes on to payments.
    expect((await advance(b, draft.id)).phase).toBe('payment_required');
  });

  it('a setup link that expired in the chat is replaced when the person starts again', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await signUp(b);
    const draft = await ask(b, 'buy me $5 worth of stickers on amazon');
    const first = (await advance(b, draft.id)).frameUrl as string;
    // Half an hour later the connection has expired: the look says so, and the next step asks for a new link.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31 * 60_000 });
    try {
      expect((await b.post('/demo/link/refresh')).body).toEqual({ link: 'expired' });
      const next = await advance(b, draft.id);
      expect(next.phase).toBe('needs_setup');
      expect(next.frameUrl).not.toBe(first);
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
    const users: Array<{ id: string; perflo: unknown }> = Object.values(store.users);
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
      const first = await ask(b, 'buy me $1.00 worth of gum on amazon');
      const frameUrl = (await advance(b, first.id)).frameUrl as string;
      await finishSetup(slow.base, frameUrl);
      await b.post('/demo/frame-events', {
        type: 'perflo:setup_completed',
        frame_session_id: new URL(frameUrl).searchParams.get('session'),
      });
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
      const reads = demo.log.forUser(userId).filter((e) => e.summary.startsWith('GET /v1/checkout/orders/'));
      expect(reads.map((e) => e.summary.replace(/ord_[A-Za-z0-9_-]+/, 'ID'))).toEqual([
        'GET /v1/checkout/orders/ID -> 200 issuing',
        'GET /v1/checkout/orders/ID -> 200 ready',
        'GET /v1/checkout/orders/ID -> 200 completed',
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

  it('stop at checkout keeps the order open, and Cancel order returns the money', async () => {
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

  it('a cancel refused while payments is busy reaches the browser as 503 with its Retry-After, sent once', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await linkedWithMoney(b, '100.00');
    expect((await b.post('/demo/mock/stop-at-checkout', { on: true })).status).toBe(200);
    const ready = await advance(b, (await ask(b, 'buy me $20 worth of books on amazon')).id);
    const cancel = vi
      .spyOn(demo.api, 'cancelOrder')
      .mockRejectedValueOnce(new PerfloApiError(503, 'service_unavailable', 'This is not available right now. Try again in a moment.', 7));
    const refused = await b.post(`/demo/cards/${ready.perfloOrderId}/cancel`);
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('7');
    expect(refused.body).toEqual({ error: { message: 'Payments are busy right now. Try again in a moment.' } });
    expect(cancel).toHaveBeenCalledTimes(1);
    // Sent again by the browser, the cancel goes through.
    const again = await b.post(`/demo/cards/${ready.perfloOrderId}/cancel`);
    expect(again.body).toMatchObject({ order: { phase: 'cancelled' } });
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
    expect((first.body.card.number as string).endsWith(first.body.card.last4 as string)).toBe(true);
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

  it('access turned off: the order asks to reconnect, then continues on its own', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await linkedWithMoney(b, '100.00');
    expect((await b.post('/demo/mock/revoke-access')).status).toBe(200);
    const draft = await ask(b, 'buy me $20 worth of books on amazon');
    const blocked = await advance(b, draft.id);
    expect(blocked.phase).toBe('connection_required');
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
    expect((await b.post('/demo/link/refresh')).status).toBe(401);
    expect(
      (
        await request(b.raw)
          .post('/demo/session')
          .set('Host', 'tiny.test')
          .set('Origin', 'https://tiny.test')
          .set('Content-Type', 'text/plain')
          .send('x')
      ).status,
    ).toBe(415);
    expect((await b.post('/demo/signup', { first_name: 'A', last_name: 'B', email: 'a@example.com' })).status).toBe(404);
    expect((await b.get('/demo/me')).status).toBe(404);
    await signUp(b);
    expect((await b.post('/demo/frame-events', { type: 'perflo:something_else', frame_session_id: 'x' })).status).toBe(400);
    expect((await b.post('/demo/orders/nope/advance')).status).toBe(404);
  });
});

describe('Add money: the amount is always the one typed in Tiny', () => {
  it('refuses a missing, empty or zero amount in plain words, before asking payments', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await signUp(b);
    for (const body of [{}, { amount: '' }, { amount: '   ' }]) {
      const res = await b.post('/demo/top-ups', body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'Enter an amount.' } });
    }
    for (const amount of ['0', '0.00', '-5', 'ten', '10.001']) {
      const res = await b.post('/demo/top-ups', { amount });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'Enter an amount above $0.00.' } });
    }
    const userId = Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0];
    expect(demo.log.forUser(userId).some((e) => e.summary.includes('/top-ups'))).toBe(false);
  });

  it('asks payments for exactly that amount and hands back its page link and the amount', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await signUp(b);
    const draft = await ask(b, 'buy me $50 worth of headphones on amazon');
    await setUp(b, (await advance(b, draft.id)).frameUrl as string);
    const res = await b.post('/demo/top-ups', { amount: '10' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      frameUrl: expect.stringContaining(`${mock.base}/v1/frames/top-up?session=`),
      clientSecret: expect.any(String),
      amount: '10.00',
    });
    const state = await frameCall(mock.base, res.body.frameUrl, 'state');
    expect(state.json).toMatchObject({ purpose: 'top-up', amount: '10.00' });
  });
});

describe('connections: Tiny reads only connection_id and connect_url, and checks at GET /v1/connections', () => {
  /** Every check of a connection Tiny made, by the address it asked. */
  const checks = (demo: ReturnType<typeof makeDemo>, userId: string) =>
    demo.log
      .forUser(userId)
      .map((e) => /^GET (\/v1\/[a-z]+)\//.exec(e.summary)?.[1])
      .filter((route): route is string => route !== undefined && route !== '/v1/checkout' && route !== '/v1/users');

  it('checks a connection at GET /v1/connections/{id}, for the first connection and for a reconnection', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await signUp(b);
    const userId = Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0];
    const first = await ask(b, 'buy me $1.00 worth of gum on amazon');
    const setup = await advance(b, first.id);
    const firstConnection = demo.store.user(userId).pendingConnection;
    await setUp(b, setup.frameUrl as string);
    await addMoney(b, '100.00');
    expect((await b.post('/demo/mock/revoke-access')).status).toBe(200);
    const second = await ask(b, 'buy me $20 worth of books on amazon');
    const blocked = await advance(b, second.id);
    expect(blocked.phase).toBe('connection_required');
    const reconnection = demo.store.user(userId).pendingConnection;
    await setUp(b, blocked.frameUrl as string);
    expect((await advance(b, second.id)).phase).toBe('completed');

    expect(firstConnection).toEqual({
      connectionId: expect.stringMatching(/^lg_/),
      connectUrl: setup.frameUrl,
      clientSecret: expect.any(String),
      orderId: null,
    });
    expect(reconnection).toMatchObject({ connectionId: expect.stringMatching(/^lg_/), connectUrl: blocked.frameUrl, orderId: second.id });
    expect(checks(demo, userId).length).toBeGreaterThan(0);
    expect(new Set(checks(demo, userId))).toEqual(new Set(['/v1/connections']));
    // The connect page link opens the connection: the log keeps only its origin and path.
    const created = demo.log.forUser(userId).find((e) => e.summary.startsWith('POST /v1/users'));
    const logged = (created?.detail as { response: Record<string, string> }).response;
    expect(logged).toMatchObject({ status: 'connection_required', connection_id: firstConnection?.connectionId });
    expect(logged.connect_url).toMatch(/\/v1\/frames\/setup\?\[redacted\]$/);
  });

  it('perflo:connection_completed links the account; the old perflo:login_completed is not an event Tiny reads', async () => {
    const demo = makeDemo(mock.base);
    const b = browser(demo);
    await signUp(b);
    const userId = Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0];
    const draft = await ask(b, 'buy me $5 worth of stickers on amazon');
    const setup = await advance(b, draft.id);
    const session = new URL(setup.frameUrl as string).searchParams.get('session');
    // Before the code is verified the connection is still pending.
    expect((await b.post('/demo/frame-events', { type: 'perflo:connection_completed', frame_session_id: session })).body).toEqual({
      link: 'pending',
    });
    await finishSetup(mock.base, setup.frameUrl as string);
    const connectionId = demo.store.user(userId).pendingConnection?.connectionId;
    const before = checks(demo, userId).length;
    const old = await b.post('/demo/frame-events', { type: 'perflo:login_completed', frame_session_id: session, login_id: connectionId });
    expect(old.status).toBe(400);
    expect(checks(demo, userId)).toHaveLength(before);
    expect((await b.post('/demo/session')).body.user.linked).toBe(false);

    const completed = await b.post('/demo/frame-events', {
      type: 'perflo:connection_completed',
      frame_session_id: session,
      connection_id: connectionId,
    });
    expect(completed.body).toEqual({ link: 'linked' });
    expect((await b.post('/demo/session')).body.user.linked).toBe(true);
    // The developer log keeps the id the page sent with the event.
    const logged = demo.log.forUser(userId).filter((e) => e.summary === 'perflo:connection_completed');
    expect(logged.map((e) => (e.detail as { connection_id?: string }).connection_id)).toEqual([undefined, connectionId]);
  });
});

describe('linked cards in test mode, through Tiny’s routes and the test payments service', () => {
  async function linked(b: ReturnType<typeof browser>) {
    await signUp(b);
    const draft = await ask(b, 'buy me $1.00 worth of gum on amazon');
    await setUp(b, (await advance(b, draft.id)).frameUrl as string);
  }

  it('links the test card with automatic top-ups, lists it, turns them off, removes it', async () => {
    const b = browser(makeDemo(mock.base));
    await linked(b);
    expect((await b.get('/demo/linked-cards')).body).toEqual({ linkedCards: [] });
    expect((await b.get('/demo/auto-top-up')).body.autoTopUp.status).toBe('off');

    const { clientSecret } = (await b.post('/demo/linked-cards/form')).body as { clientSecret: string };
    const autoTopUp = { monthlyLimit: '250.00' };
    const token = await b.post('/demo/mock/card-token', { clientSecret, autoTopUp });
    expect(token.status).toBe(200);
    const saved = await b.post('/demo/linked-cards', { cardToken: token.body.cardToken, autoTopUp });
    expect(saved.body).toMatchObject({
      status: 'linked',
      linkedCard: { last4: '4242' },
      autoTopUp: { status: 'on', monthlyLimit: '250.00' },
    });
    const cardId = saved.body.linkedCard.id as string;

    // The same card token again (Try again) answers the same link: nothing is linked twice.
    expect((await b.post('/demo/linked-cards', { cardToken: token.body.cardToken, autoTopUp })).body).toEqual(saved.body);
    expect((await b.get('/demo/linked-cards')).body.linkedCards).toEqual([
      { id: cardId, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, usedForAutoTopUp: true },
    ]);
    expect((await b.get('/demo/auto-top-up')).body.autoTopUp).toEqual({ status: 'on', monthlyLimit: '250.00', linkedCardId: cardId });

    expect((await b.post('/demo/auto-top-up/turn-off')).body).toEqual({ ok: true });
    expect((await b.get('/demo/auto-top-up')).body.autoTopUp.status).toBe('off');
    expect((await b.get('/demo/linked-cards')).body.linkedCards).toHaveLength(1);
    expect((await b.post(`/demo/linked-cards/${cardId}/remove`)).body).toEqual({ ok: true });
    expect((await b.get('/demo/linked-cards')).body.linkedCards).toEqual([]);
  });

  it('refuses a limit the person did not agree to, a limit out of range, and too many tries, in plain words', async () => {
    const b = browser(makeDemo(mock.base));
    await linked(b);
    const { clientSecret } = (await b.post('/demo/linked-cards/form')).body as { clientSecret: string };
    const cardOnly = await b.post('/demo/mock/card-token', { clientSecret, autoTopUp: null });
    const mismatch = await b.post('/demo/linked-cards', { cardToken: cardOnly.body.cardToken, autoTopUp: { monthlyLimit: '250.00' } });
    expect([mismatch.status, mismatch.body.error.message]).toEqual([
      502,
      'Payments could not do that right now. Try again in a few minutes.',
    ]);
    const outOfRange = await b.post('/demo/mock/card-token', { clientSecret, autoTopUp: { monthlyLimit: '5000.00' } });
    expect([outOfRange.status, outOfRange.body.error.message]).toEqual([422, 'Choose a monthly limit between $50.00 and $2,000.00.']);
    for (let i = 0; i < 4; i++) expect((await b.post('/demo/mock/card-token', { clientSecret, autoTopUp: null })).status).toBe(200);
    const capped = await b.post('/demo/mock/card-token', { clientSecret, autoTopUp: null });
    expect([capped.status, capped.body.error.message]).toEqual([429, 'Too many cards were tried. Wait a while and try again.']);
    // The card token the person did not use for the mismatch still links the card on its own.
    expect((await b.post('/demo/linked-cards', { cardToken: cardOnly.body.cardToken, autoTopUp: null })).body.status).toBe('linked');
  });
});
