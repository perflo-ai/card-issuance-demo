import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoApp } from '../server/app.js';
import type { DemoConfig } from '../server/config.js';
import { EventLog } from '../server/eventLog.js';
import { lookFields } from '../server/looks.js';
import { toView } from '../server/orderState.js';
import { PerfloApi } from '../server/perfloApi.js';
import { DemoService } from '../server/service.js';
import { verifySignature } from '../server/signing.js';
import { Store } from '../server/store.js';
import type { OrderView } from '../server/views.js';
import {
  CREDS,
  finishSetup,
  makeDemo,
  sessionOf,
  startMock,
  TEST_HOST,
  TEST_ORIGIN,
  urlOf,
  WEBHOOK_SECRET,
  type LooseJson,
} from './helpers.js';

const BASE = 'https://perflo.test';

describe('the example looks', () => {
  it('sends nothing for the brand default, so those requests are what Tiny sent before looks existed', () => {
    expect(lookFields('brand', 'sign_in')).toEqual({});
    expect(lookFields('brand', 'limits')).toEqual({});
    expect(lookFields('brand', 'payment')).toEqual({});
  });

  it('sends the payment form options only to a page that takes a payment', () => {
    for (const look of ['flat', 'night'] as const) {
      expect(lookFields(look, 'sign_in').appearance).toBeDefined();
      expect(lookFields(look, 'sign_in').payment_element_options).toBeUndefined();
      expect(lookFields(look, 'limits').payment_element_options).toBeUndefined();
      expect(lookFields(look, 'payment').payment_element_options).toBeDefined();
    }
    expect(lookFields('night', 'payment').appearance?.theme).toBe('dark');
    expect(lookFields('night', 'payment').appearance?.rules?.['.Input']).toBeDefined();
    expect(lookFields('flat', 'payment').appearance?.theme).toBe('light');
  });

  it('hands out a copy: changing what one request got never changes the list', () => {
    const first = lookFields('night', 'payment');
    (first.appearance as { theme?: string }).theme = 'light';
    expect(lookFields('night', 'payment').appearance?.theme).toBe('dark');
  });
});

/** Perflo answers scripted per route; every call is kept with its parsed body and whether its signature verifies. */
function scripted(routes: Record<string, Array<{ status: number; body: unknown }>>) {
  const calls: Array<{ key: string; body: LooseJson; keyVersion: string | undefined; signed: boolean }> = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(urlOf(input));
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname}`;
    const raw = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.alloc(0);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
    const verified = verifySignature(headers, method, url.pathname, raw, () => ({ [CREDS.keyVersion]: CREDS.secret }));
    calls.push({
      key,
      body: raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined,
      keyVersion: headers['x-partner-key-version'],
      signed: verified.ok,
    });
    const next = Object.hasOwn(routes, key) ? routes[key].shift() : undefined;
    if (!next) throw new Error(`unscripted call: ${key}`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fake, calls };
}

function live(fake: typeof fetch) {
  const config: DemoConfig = {
    mode: 'live',
    perfloApiBase: BASE,
    perfloOrigin: BASE,
    credentials: CREDS,
    dataFile: join(mkdtempSync(join(tmpdir(), 'tiny-looks-')), 's.json'),
    listen: { kind: 'local' },
    publicOrigin: null,
    webhookSecret: WEBHOOK_SECRET,
    mockReuseCards: false,
  };
  const log = new EventLog();
  const store = new Store(config.dataFile);
  const service = new DemoService(store, new PerfloApi(BASE, CREDS, log, fake), log, config, fake);
  return { service, store, log };
}

const SECRET = `fs_${'a'.repeat(43)}.${'b'.repeat(43)}`;
const EXPIRES = '2026-10-14T12:00:00.000Z';

describe('requests Perflo gets carry the chosen look, signed as before', () => {
  it('POST /v1/users carries the look for the sign-in page, and the sign-in keeps its client_secret', async () => {
    const { fake, calls } = scripted({
      'POST /v1/users': [
        {
          status: 202,
          body: {
            status: 'login_required',
            login_id: 'lgn_1',
            login_url: `${BASE}/v1/frames/setup?session=x`,
            client_secret: SECRET,
            expires_at: EXPIRES,
          },
        },
      ],
    });
    const { service, store } = live(fake);
    const { user } = store.createUser();
    const chosen = service.setLook(user, 'night');
    const result = await service.signIn(chosen);
    expect(result).toEqual({ link: 'login_required', page: { url: `${BASE}/v1/frames/setup?session=x`, clientSecret: SECRET } });
    expect(calls[0].body).toEqual({ external_user_id: user.id, ...lookFields('night', 'sign_in') });
    expect(calls[0].body.payment_element_options).toBeUndefined();
    expect(calls[0].keyVersion).toBe(CREDS.keyVersion);
    expect(calls[0].signed).toBe(true);
    expect(store.user(user.id).pendingLogin?.clientSecret).toBe(SECRET);
  });

  it('a top-up carries the look and the payment form options; a limits link carries the look', async () => {
    const { fake, calls } = scripted({
      'POST /v1/users/usr_1/top-ups': [
        {
          status: 201,
          body: {
            top_up_id: 'tu_1',
            frame_url: `${BASE}/v1/frames/top-up?session=y`,
            client_secret: SECRET,
            amount: '25.00',
            expires_at: EXPIRES,
          },
        },
      ],
      'POST /v1/users/usr_1/limits-link': [
        { status: 201, body: { frame_url: `${BASE}/v1/frames/limits?session=z`, client_secret: SECRET, expires_at: EXPIRES } },
      ],
    });
    const { service, store } = live(fake);
    const { user } = store.createUser();
    store.updateUser(user.id, (u) => (u.perflo = { userId: 'usr_1', token: 'ptk_test_token_value' }));
    const chosen = service.setLook(user, 'flat');
    expect(await service.topUpLink(chosen, 2500)).toEqual({ url: `${BASE}/v1/frames/top-up?session=y`, clientSecret: SECRET });
    expect(await service.limitsLink(chosen)).toEqual({ url: `${BASE}/v1/frames/limits?session=z`, clientSecret: SECRET });
    expect(calls[0].body).toEqual({ amount: '25.00', ...lookFields('flat', 'payment') });
    expect(calls[0].body.payment_element_options).toEqual({ layout: 'tabs' });
    expect(calls[1].body).toEqual(lookFields('flat', 'limits'));
    expect(calls.every((c) => c.signed && c.keyVersion === CREDS.keyVersion)).toBe(true);
  });

  it('the brand default sends a limits link with no body at all, as before', async () => {
    const { fake, calls } = scripted({
      'POST /v1/users/usr_1/limits-link': [{ status: 201, body: { frame_url: `${BASE}/v1/frames/limits?session=z`, expires_at: EXPIRES } }],
    });
    const { service, store } = live(fake);
    const { user } = store.createUser();
    const linked = store.updateUser(user.id, (u) => (u.perflo = { userId: 'usr_1', token: 'ptk_test_token_value' }));
    // A Perflo without client_secret: the page is still given its link.
    expect(await service.limitsLink(linked)).toEqual({ url: `${BASE}/v1/frames/limits?session=z` });
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].signed).toBe(true);
  });

  it('an order keeps the look it was made with, so every POST with its Idempotency-Key is the same body', async () => {
    const answer = {
      status: 202,
      body: {
        order_id: 'ord_1',
        status: 'payment_required',
        frame_url: `${BASE}/v1/frames/top-up?session=y`,
        client_secret: SECRET,
        amount_due: '50.00',
      },
    };
    const { fake, calls } = scripted({ 'POST /v1/checkout/orders': [answer] });
    const { service, store } = live(fake);
    let { user } = store.createUser();
    user = store.updateUser(user.id, (u) => (u.perflo = { userId: 'usr_1', token: 'ptk_test_token_value' }));
    user = service.setLook(user, 'night');
    const order = store.createOrder(user.id, {
      merchantName: 'Amazon',
      domain: 'amazon.com',
      amountCents: 5000,
      description: 'headphones',
    });
    // The person picks another look after asking for the order: the order keeps its own.
    user = service.setLook(user, 'flat');
    const result = await service.advanceOrder(user, order.id);
    expect(calls[0].body.appearance).toEqual(lookFields('night', 'payment').appearance);
    expect(calls[0].body.payment_element_options).toEqual(lookFields('night', 'payment').payment_element_options);
    expect(calls[0].body.user_id).toBe('usr_1');
    expect(calls[0].signed).toBe(true);
    const fresh = store.user(user.id);
    expect(toView(result.order, fresh)).toMatchObject({ phase: 'payment_required', clientSecret: SECRET, amountDue: '50.00' });
  });
});

describe('the browser names a look by its id, and nothing else', () => {
  let mock: { base: string; close: () => Promise<void> };
  beforeEach(async () => {
    mock = await startMock(50);
  });
  afterEach(async () => {
    await mock.close();
  });

  function browser(mode: 'mock' | 'live' = 'mock') {
    const demo = makeDemo(mock.base, mode);
    const app = createDemoApp({ config: demo.config, store: demo.store, service: demo.service, log: demo.log, logger: demo.logger });
    let cookie = '';
    const keep = (res: request.Response) => {
      const set = res.headers['set-cookie'] as unknown as string[] | undefined;
      if (set?.length) cookie = set[0].split(';')[0];
      return res;
    };
    return {
      demo,
      post: async (path: string, body: unknown = {}) =>
        keep(
          await request(app)
            .post(path)
            .set('Host', TEST_HOST)
            .set('Origin', TEST_ORIGIN)
            .set('Cookie', cookie)
            .send(body as object),
        ),
      get: async (path: string) => keep(await request(app).get(path).set('Host', TEST_HOST).set('Cookie', cookie)),
    };
  }

  it('saves a look from the list, and refuses an unknown id or an appearance sent with it', async () => {
    const b = browser();
    await b.post('/demo/session');
    const saved = await b.post('/demo/look', { look: 'night' });
    expect(saved.status).toBe(200);
    expect(saved.body.user.look).toBe('night');
    expect((await b.post('/demo/look', { look: 'neon' })).status).toBe(400);
    expect((await b.post('/demo/look', { look: 'night', appearance: { theme: 'light' } })).status).toBe(400);
    expect((await b.post('/demo/look', { appearance: { variables: { colorPrimary: '#000000' } } })).status).toBe(400);
    expect((await b.post('/demo/session')).body.user.look).toBe('night');
  });

  it('refuses appearance or payment form options on every page the browser opens', async () => {
    const b = browser();
    await b.post('/demo/session');
    expect((await b.post('/demo/sign-in', { appearance: { theme: 'dark' } })).status).toBe(400);
    expect((await b.post('/demo/top-ups', { amount: '10.00', appearance: { theme: 'dark' } })).status).toBe(400);
    expect((await b.post('/demo/top-ups', { payment_element_options: { layout: 'tabs' } })).status).toBe(400);
    expect((await b.post('/demo/limits-link', { appearance: { theme: 'dark' } })).status).toBe(400);
  });

  it('gives the page each client_secret beside its link, and keeps it out of the developer log', async () => {
    const b = browser();
    await b.post('/demo/session');
    const started = await b.post('/demo/sign-in');
    expect(started.status).toBe(200);
    expect(started.body.link).toBe('login_required');
    const { url, clientSecret } = started.body.page as { url: string; clientSecret: string };
    expect(clientSecret).toBe(sessionOf(url));

    // The chat's order waiting on the same sign-in shows the same page.
    const asked = await b.post('/demo/chat', { text: 'buy me $50 worth of headphones on amazon' });
    const advanced = await b.post(`/demo/orders/${(asked.body.order as OrderView).id}/advance`);
    expect(advanced.body.order).toMatchObject({ phase: 'needs_setup', frameUrl: url, clientSecret });

    // The page finishes the sign-in (UI elements send no frame event; the page asks Tiny to look).
    await finishSetup(mock.base, url);
    expect((await b.post('/demo/link/refresh')).body).toEqual({ link: 'linked' });
    expect((await b.post('/demo/sign-in')).body).toEqual({ link: 'linked' });

    const topUp = await b.post('/demo/top-ups', { amount: '25.00' });
    expect(topUp.body.clientSecret).toBe(sessionOf(topUp.body.frameUrl));
    const limits = await b.post('/demo/limits-link');
    expect(limits.body.clientSecret).toBe(sessionOf(limits.body.frameUrl));

    const log = JSON.stringify((await b.get('/demo/events')).body);
    for (const secret of [clientSecret, topUp.body.clientSecret, limits.body.clientSecret]) expect(log).not.toContain(secret);
  });

  it('tells the page where Perflo.js is in live mode, and that there is none in mock mode', async () => {
    expect((await browser('mock').get('/demo/config')).body.perfloScriptUrl).toBeNull();
    expect((await browser('live').get('/demo/config')).body.perfloScriptUrl).toBe(`${mock.base}/v1/perflo.js`);
  });
});
