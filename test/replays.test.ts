import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DemoConfig } from '../server/config.js';
import { EventLog } from '../server/eventLog.js';
import { toView } from '../server/orderState.js';
import { PerfloApi } from '../server/perfloApi.js';
import { DemoService } from '../server/service.js';
import { Store } from '../server/store.js';
import { CREDS } from './helpers.js';

const BASE = 'https://perflo.test';

/** bapi's final replay shapes, scripted: each route answers from its own queue, every call is recorded. */
function scripted(routes: Record<string, Array<{ status: number; body: unknown }>>) {
  const calls: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const key = url.origin === BASE ? `${method} ${url.pathname}` : `${method} ${url.origin}${url.pathname}`;
    calls.push({ method, path: url.pathname, headers: { ...(init?.headers as Record<string, string>) } });
    const next = routes[key]?.shift();
    if (!next) throw new Error(`unscripted call: ${key}`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fake, calls };
}

function setup(fake: typeof fetch, linked = true) {
  const config: DemoConfig = { mode: 'live', perfloApiBase: BASE, perfloOrigin: BASE, credentials: CREDS, dataFile: join(mkdtempSync(join(tmpdir(), 'tiny-replay-')), 's.json') };
  const log = new EventLog();
  const store = new Store(config.dataFile);
  const service = new DemoService(store, new PerfloApi(BASE, CREDS, log, fake), log, config, fake);
  let { user } = store.createUser('Ada', 'Lovelace', 'ada@example.com');
  if (linked) user = store.updateUser(user.id, (u) => (u.perflo = { userId: 'usr_1', token: 'ptk_test_token_value' }));
  const order = store.createOrder(user.id, { merchantName: 'United', domain: 'united.com', amountCents: 25000, description: 'flight' });
  return { service, store, user, order };
}

describe('identity_check_required without a link', () => {
  it('a POST replay without kyc_url triggers one GET; a null link there shows the plain retry copy', async () => {
    const { fake, calls } = scripted({
      'POST /partner/v2/orders': [{ status: 202, body: { order_id: 'ord_1', status: 'identity_check_required', message: 'Already placed.' } }],
      'GET /partner/v2/orders/ord_1': [{ status: 200, body: { order_id: 'ord_1', status: 'identity_check_required', kyc_url: null } }],
    });
    const { service, user, order } = setup(fake);
    const result = await service.advanceOrder(user, order.id);
    const view = toView(result.order, result.user);
    expect(view.phase).toBe('identity_check_required');
    expect(view).not.toHaveProperty('kycUrl');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /partner/v2/orders', 'GET /partner/v2/orders/ord_1']);
  });

  it('the GET supplies a fresh link when there is one', async () => {
    const { fake } = scripted({
      'POST /partner/v2/orders': [{ status: 202, body: { order_id: 'ord_1', status: 'identity_check_required', message: 'Already placed.' } }],
      'GET /partner/v2/orders/ord_1': [{ status: 200, body: { order_id: 'ord_1', status: 'identity_check_required', kyc_url: 'https://kyc.test/start' } }],
    });
    const { service, user, order } = setup(fake);
    const result = await service.advanceOrder(user, order.id);
    expect(toView(result.order, result.user).kycUrl).toBe('https://kyc.test/start');
  });
});

describe('reveal links are never replayed', () => {
  it('a ready replay without reveal_url uses card-reveal; a {message} replay is retried with a NEW key', async () => {
    const ready = { order_id: 'ord_1', status: 'ready', card_id: 'card_1', last4: '4417', card_limit: '250.00', card_expires_at: '2026-10-08T12:00:00Z' };
    const { fake, calls } = scripted({
      'POST /partner/v2/orders': [{ status: 201, body: ready }],
      'POST /partner/v2/orders/ord_1/card-reveal': [
        { status: 201, body: { message: 'Already handed out.' } },
        { status: 201, body: { reveal_url: 'https://relay.test/partner-cards/card_1/sensitive?t=abc', reveal_expires_at: '2026-10-08T00:15:00Z' } },
      ],
      'GET https://relay.test/partner-cards/card_1/sensitive': [
        { status: 200, body: { success: true, data: { card_number: '4000123412344417', cvv: '123', exp_month: '10', exp_year: '2029', holder_name: 'Ada Lovelace', last4: '4417' } } },
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
    const ready = { order_id: 'ord_1', status: 'ready', card_id: 'card_1', last4: '4417', card_limit: '250.00', card_expires_at: '2026-10-08T12:00:00Z' };
    const { fake } = scripted({
      'POST /partner/v2/orders': [{ status: 201, body: ready }],
      'POST /partner/v2/orders/ord_1/card-reveal': [
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
      'POST /partner/v2/users': [
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
