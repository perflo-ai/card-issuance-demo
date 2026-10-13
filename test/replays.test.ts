import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DemoConfig } from '../server/config.js';
import { EventLog } from '../server/eventLog.js';
import { toView } from '../server/orderState.js';
import { PerfloApi } from '../server/perfloApi.js';
import { DemoService } from '../server/service.js';
import { Store } from '../server/store.js';
import { CREDS, urlOf, WEBHOOK_SECRET } from './helpers.js';

const BASE = 'https://perflo.test';

/** bapi's final replay shapes, scripted: each route answers from its own queue, every call is recorded. */
function scripted(routes: Record<string, Array<{ status: number; body: unknown }>>) {
  const calls: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(urlOf(input));
    const method = init?.method ?? 'GET';
    const key = url.origin === BASE ? `${method} ${url.pathname}` : `${method} ${url.origin}${url.pathname}`;
    calls.push({ method, path: url.pathname, headers: { ...(init?.headers as Record<string, string>) } });
    const next = Object.hasOwn(routes, key) ? routes[key].shift() : undefined;
    if (!next) throw new Error(`unscripted call: ${key}`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fake, calls };
}

function setup(fake: typeof fetch, linked = true) {
  const config: DemoConfig = {
    mode: 'live',
    perfloApiBase: BASE,
    perfloOrigin: BASE,
    credentials: CREDS,
    dataFile: join(mkdtempSync(join(tmpdir(), 'tiny-replay-')), 's.json'),
    listen: { kind: 'local' },
    publicOrigin: null,
    webhookSecret: WEBHOOK_SECRET,
    mockReuseCards: false,
  };
  const log = new EventLog();
  const store = new Store(config.dataFile);
  const service = new DemoService(store, new PerfloApi(BASE, CREDS, log, fake), log, config, fake);
  let { user } = store.createUser();
  if (linked) user = store.updateUser(user.id, (u) => (u.perflo = { userId: 'usr_1', token: 'ptk_test_token_value' }));
  const order = store.createOrder(user.id, { merchantName: 'United', domain: 'united.com', amountCents: 25000, description: 'flight' });
  return { service, store, user, order };
}

describe('identity_check_required without a link', () => {
  it('a POST replay without kyc_url triggers one GET; a null link there shows the plain retry copy', async () => {
    const { fake, calls } = scripted({
      'POST /v1/checkout/orders': [
        { status: 202, body: { order_id: 'ord_1', status: 'identity_check_required', message: 'Already placed.' } },
      ],
      'GET /v1/checkout/orders/ord_1': [{ status: 200, body: { order_id: 'ord_1', status: 'identity_check_required', kyc_url: null } }],
    });
    const { service, user, order } = setup(fake);
    const result = await service.advanceOrder(user, order.id);
    const view = toView(result.order, result.user);
    expect(view.phase).toBe('identity_check_required');
    expect(view).not.toHaveProperty('kycUrl');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/checkout/orders', 'GET /v1/checkout/orders/ord_1']);
  });

  it('the GET supplies a fresh link when there is one', async () => {
    const { fake } = scripted({
      'POST /v1/checkout/orders': [
        { status: 202, body: { order_id: 'ord_1', status: 'identity_check_required', message: 'Already placed.' } },
      ],
      'GET /v1/checkout/orders/ord_1': [
        { status: 200, body: { order_id: 'ord_1', status: 'identity_check_required', kyc_url: 'https://kyc.test/start' } },
      ],
    });
    const { service, user, order } = setup(fake);
    const result = await service.advanceOrder(user, order.id);
    expect(toView(result.order, result.user).kycUrl).toBe('https://kyc.test/start');
  });
});

describe('reveal links are never replayed', () => {
  it('a ready replay without reveal_url uses card-reveal; a {message} replay is retried with a NEW key', async () => {
    const ready = {
      order_id: 'ord_1',
      status: 'ready',
      card_id: 'card_1',
      last4: '4417',
      card_limit: '250.00',
      card_expires_at: '2026-10-08T12:00:00Z',
    };
    const { fake, calls } = scripted({
      'POST /v1/checkout/orders': [{ status: 201, body: ready }],
      'POST /v1/checkout/orders/ord_1/card-reveal': [
        { status: 201, body: { message: 'Already handed out.' } },
        {
          status: 201,
          body: { reveal_url: 'https://relay.test/partner-cards/card_1/sensitive?t=abc', reveal_expires_at: '2026-10-08T00:15:00Z' },
        },
      ],
      'GET https://relay.test/partner-cards/card_1/sensitive': [
        {
          status: 200,
          body: {
            success: true,
            data: {
              card_number: '4000123412344417',
              cvv: '123',
              exp_month: '10',
              exp_year: '2029',
              holder_name: 'Ada Lovelace',
              last4: '4417',
            },
          },
        },
      ],
    });
    const { service, user, order } = setup(fake);
    const result = await service.advanceOrder(user, order.id);
    expect(result.notice).toBeNull();
    expect(toView(result.order, result.user).checkout).toMatchObject({ last4: '4417', outcome: 'filled_not_submitted' });
    const reveals = calls.filter((c) => c.path.endsWith('/card-reveal'));
    expect(reveals).toHaveLength(2);
    expect(reveals[0].headers['Idempotency-Key']).toBeTruthy();
    expect(reveals[1].headers['Idempotency-Key']).toBeTruthy();
    expect(reveals[0].headers['Idempotency-Key']).not.toBe(reveals[1].headers['Idempotency-Key']);
  });

  it('two replays in a row become a plain failure the person can retry', async () => {
    const ready = {
      order_id: 'ord_1',
      status: 'ready',
      card_id: 'card_1',
      last4: '4417',
      card_limit: '250.00',
      card_expires_at: '2026-10-08T12:00:00Z',
    };
    const { fake } = scripted({
      'POST /v1/checkout/orders': [{ status: 201, body: ready }],
      'POST /v1/checkout/orders/ord_1/card-reveal': [
        { status: 201, body: { message: 'Already handed out.' } },
        { status: 201, body: { message: 'Already handed out.' } },
      ],
    });
    const { service, user, order } = setup(fake);
    await expect(service.advanceOrder(user, order.id)).rejects.toThrow('Payments did not hand out a card link');
  });
});

describe('POST /users replays never carry a token', () => {
  it('approved without a token, then a tokenless reissue replay, then a token: each reissue uses a new key', async () => {
    const { fake, calls } = scripted({
      'POST /v1/users': [
        { status: 200, body: { status: 'approved', user_id: 'usr_1' } },
        { status: 200, body: { status: 'approved', user_id: 'usr_1' } },
        { status: 200, body: { status: 'approved', user_id: 'usr_1', user_access_token: 'ptk_test_fresh_token' } },
      ],
    });
    const { service, store, user } = setup(fake, false);
    const result = await service.ensureLinked(user);
    expect(result.status).toBe('linked');
    expect(store.user(user.id).perflo).toEqual({ userId: 'usr_1', token: 'ptk_test_fresh_token' });
    const keys = calls.map((c) => c.headers['Idempotency-Key']);
    expect(keys[0]).toBeUndefined();
    expect(keys[1]).toBeTruthy();
    expect(keys[2]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[2]);
  });
});

describe('the orders list reads moving orders from Perflo', () => {
  it('regression: 2026-10-08 an order still issuing locally shows ready once Perflo says so, by a GET and never a new order', async () => {
    const ready = {
      order_id: 'ord_1',
      status: 'ready',
      card_id: 'card_1',
      last4: '2852',
      card_limit: '20.00',
      card_expires_at: '2026-10-09T02:06:30.202Z',
      reveal_url: 'https://perflo.test/reveal/once',
      reveal_expires_at: '2026-10-08T14:20:00.000Z',
    };
    const { fake, calls } = scripted({ 'GET /v1/checkout/orders/ord_1': [{ status: 200, body: ready }] });
    const { service, store, user, order } = setup(fake);
    store.updateOrder(order, (o) => {
      o.state = 'placed';
      o.perfloOrderId = 'ord_1';
      o.last = { order_id: 'ord_1', status: 'issuing' };
    });

    await service.refreshOrders(user);

    const view = toView(store.order(user.id, order.id)!, store.user(user.id));
    expect(view.phase).toBe('ready');
    expect(view.cardLast4).toBe('2852');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/checkout/orders/ord_1']);
    // The one-time reveal link is never kept, and a refresh never opens the card.
    expect(JSON.stringify(store.order(user.id, order.id))).not.toContain('reveal/once');
    expect(store.order(user.id, order.id)!.revealUsed).toBe(false);
  });

  it('leaves settled orders and orders never sent alone, and keeps the last status when the read fails', async () => {
    const busy = { status: 503, body: { error: { code: 'service_unavailable', message: 'Try again.' } } };
    const { fake, calls } = scripted({ 'GET /v1/checkout/orders/ord_2': [busy, busy, busy] });
    const { service, store, user, order } = setup(fake);
    store.updateOrder(order, (o) => {
      o.state = 'placed';
      o.perfloOrderId = 'ord_done';
      o.last = { order_id: 'ord_done', status: 'cancelled' };
    });
    const moving = store.createOrder(user.id, {
      merchantName: 'Amazon',
      domain: 'amazon.com',
      amountCents: 2000,
      description: 'headphones',
    });
    store.updateOrder(moving, (o) => {
      o.state = 'placed';
      o.perfloOrderId = 'ord_2';
      o.last = { order_id: 'ord_2', status: 'issuing' };
    });
    store.createOrder(user.id, { merchantName: 'Amazon', domain: 'amazon.com', amountCents: 500, description: 'cable' });

    await service.refreshOrders(user);

    // A read is tried three times when payments says to try again; then the last known status stays.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(Array(3).fill('GET /v1/checkout/orders/ord_2'));
    expect(store.order(user.id, moving.id)!.last?.status).toBe('issuing');
  });
});

describe('one person, one Tiny account, decided by Perflo', () => {
  const intent = { merchantName: 'Amazon', domain: 'amazon.com', amountCents: 2000, description: 'headphones' };

  it("linking to a Perflo user who already has a Tiny account brings that account's orders along", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'tiny-link-')), 's.json'));
    const first = store.createUser();
    store.linkPerflo(first.user.id, { userId: 'usr_1', token: 'ptk_first_token_value' });
    store.createOrder(first.user.id, intent);

    const again = store.createUser();
    expect(store.ordersFor(again.user.id)).toHaveLength(0);
    store.linkPerflo(again.user.id, { userId: 'usr_1', token: 'ptk_second_token_value' });

    expect(store.ordersFor(again.user.id)).toHaveLength(1);
    expect(store.userForSession(first.sessionId)?.id).toBe(again.user.id);
    expect(() => store.user(first.user.id)).toThrow();
  });

  it('never joins accounts linked to different Perflo users', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'tiny-email-')), 's.json'));
    const owner = store.createUser();
    store.linkPerflo(owner.user.id, { userId: 'usr_1', token: 'ptk_owner_token_value' });
    store.createOrder(owner.user.id, intent);
    const stranger = store.createUser();
    store.linkPerflo(stranger.user.id, { userId: 'usr_2', token: 'ptk_stranger_token_value' });

    expect(store.ordersFor(stranger.user.id)).toHaveLength(0);
    expect(store.ordersFor(owner.user.id)).toHaveLength(1);
  });

  it('folds accounts an earlier version left for one Perflo user into the newest, when the store opens', () => {
    // Session ids as Tiny makes them (43 base64url characters); the old file shape stored the user id alone.
    const [S1, S2, S3] = ['a', 'b', 'c'].map((c) => c.repeat(43));
    const file = join(mkdtempSync(join(tmpdir(), 'tiny-open-')), 's.json');
    const user = (id: string, createdAt: string, perfloUserId: string | null) => ({
      id,
      firstName: 'Ada',
      lastName: 'L',
      email: 'ada@example.com',
      createdAt,
      perflo: perfloUserId ? { userId: perfloUserId, token: `ptk_${id}_token_value` } : null,
      pendingLogin: null,
    });
    const order = (id: string, demoUserId: string) => ({
      id,
      demoUserId,
      idempotencyKey: id,
      intent,
      state: 'draft',
      perfloOrderId: null,
      last: null,
      revealUsed: false,
      checkout: null,
      amountReturned: null,
      createdAt: '2026-10-08T10:00:00.000Z',
    });
    writeFileSync(
      file,
      JSON.stringify({
        sessions: { [S1]: 'old', [S2]: 'new', [S3]: 'unlinked' },
        users: {
          old: user('old', '2026-10-08T08:00:00.000Z', 'usr_1'),
          new: user('new', '2026-10-08T14:00:00.000Z', 'usr_1'),
          unlinked: user('unlinked', '2026-10-08T15:00:00.000Z', null),
        },
        orders: { o1: order('o1', 'old'), o2: order('o2', 'new'), o3: order('o3', 'unlinked') },
      }),
    );

    const store = new Store(file);
    expect(store.userForSession(S1)?.id).toBe('new');
    expect(
      store
        .ordersFor('new')
        .map((o) => o.id)
        .sort(),
    ).toEqual(['o1', 'o2']);
    expect(store.ordersFor('unlinked').map((o) => o.id)).toEqual(['o3']);
    expect(store.user('new').perflo?.token).toBe('ptk_new_token_value');
    expect(new Store(file).userForSession(S1)?.id).toBe('new');
    // Names and emails typed at the old sign-up are dropped from the file: nothing uses them any more.
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toContain('ada@example.com');
    expect(saved).not.toContain('firstName');
    expect(Object.keys(store.user('unlinked')).sort()).toEqual(['createdAt', 'id', 'pendingLogin', 'perflo']);
  });
});
