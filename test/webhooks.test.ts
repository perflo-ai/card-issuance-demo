/**
 * Perflo webhooks instead of polling: the signature check, the endpoint (dedupe, refusals), the
 * whole flow driven by webhooks from the mock with nothing asking again and again, and the live
 * feed that carries the result to the person's page.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoApp } from '../server/app.js';
import { recordAnswer, toView } from '../server/orderState.js';
import { Store } from '../server/store.js';
import type { OrderView } from '../server/views.js';
import { verifyWebhook, WEBHOOK_PATH, webhookCanonicalString, webhookHeaders } from '../server/webhooks.js';
import { finishSetup, makeDemo, openStream, payInFrame, startMock, wait, WEBHOOK_SECRET } from './helpers.js';

const NOW = 1_791_600_000;
const body = (event: object) => Buffer.from(JSON.stringify(event), 'utf8');
const lower = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

describe('verifyWebhook', () => {
  const raw = body({ id: 'evt_1', type: 'order.ready', created_at: '2026-10-09T12:00:00.000Z', data: { order_id: 'ord_1' } });
  const signed = (overrides: { path?: string; secret?: string; at?: number; key?: string } = {}) =>
    lower(
      webhookHeaders(
        overrides.secret ?? WEBHOOK_SECRET,
        overrides.key ?? 'wh1',
        overrides.path ?? WEBHOOK_PATH,
        raw,
        'evt_1',
        overrides.at ?? NOW,
      ),
    );

  it('accepts a try signed with the webhook secret over the documented six lines', () => {
    expect(verifyWebhook(signed(), WEBHOOK_PATH, raw, WEBHOOK_SECRET, NOW)).toEqual({ ok: true, eventId: 'evt_1' });
    // The exact string, so a partner copying this template signs the same bytes Perflo does.
    expect(webhookCanonicalString('wh1', WEBHOOK_PATH, String(NOW), raw).split('\n')).toEqual([
      'perflo-webhook-v1',
      'wh1',
      'POST',
      '/webhooks/perflo',
      String(NOW),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
  });

  it('refuses another secret (the partner API secret included)', () => {
    expect(verifyWebhook(signed({ secret: 'whsec_' + 'x'.repeat(43) }), WEBHOOK_PATH, raw, WEBHOOK_SECRET, NOW)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('refuses a body changed on the way', () => {
    const changed = Buffer.from(raw.toString('utf8').replace('ord_1', 'ord_2'), 'utf8');
    expect(verifyWebhook(signed(), WEBHOOK_PATH, changed, WEBHOOK_SECRET, NOW)).toMatchObject({ ok: false, reason: 'signature_invalid' });
  });

  it('refuses a try signed for another path', () => {
    expect(verifyWebhook(signed({ path: '/somewhere/else' }), WEBHOOK_PATH, raw, WEBHOOK_SECRET, NOW)).toMatchObject({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('refuses a try more than two minutes from our clock, either way (a replay later is useless)', () => {
    expect(verifyWebhook(signed({ at: NOW - 121 }), WEBHOOK_PATH, raw, WEBHOOK_SECRET, NOW)).toMatchObject({
      reason: 'outside_time_window',
    });
    expect(verifyWebhook(signed({ at: NOW + 121 }), WEBHOOK_PATH, raw, WEBHOOK_SECRET, NOW)).toMatchObject({
      reason: 'outside_time_window',
    });
    expect(verifyWebhook(signed({ at: NOW - 120 }), WEBHOOK_PATH, raw, WEBHOOK_SECRET, NOW)).toMatchObject({ ok: true });
  });

  it('refuses missing or malformed headers before computing anything', () => {
    const { 'x-perflo-signature': _gone, ...missing } = signed();
    expect(verifyWebhook(missing, WEBHOOK_PATH, raw, WEBHOOK_SECRET, NOW)).toMatchObject({ reason: 'header_missing' });
    expect(verifyWebhook({ ...signed(), 'x-perflo-timestamp': 'soon' }, WEBHOOK_PATH, raw, WEBHOOK_SECRET, NOW)).toMatchObject({
      reason: 'header_malformed',
    });
  });
});

/** Posts one webhook to the demo app the way Perflo does. */
function postWebhook(
  app: ReturnType<typeof createDemoApp>,
  event: object,
  options: { secret?: string; eventId?: string; at?: number } = {},
) {
  const raw = body(event);
  const id = options.eventId ?? (event as { id: string }).id;
  const headers = webhookHeaders(options.secret ?? WEBHOOK_SECRET, 'wh1', WEBHOOK_PATH, raw, id, options.at);
  let req = request(app).post(WEBHOOK_PATH);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  // A string, so the test client sends these exact bytes (it would serialise a Buffer as JSON).
  return req.send(raw.toString('utf8'));
}

describe('the webhook endpoint', () => {
  const ping = { id: 'evt_ping_1', type: 'ping', created_at: '2026-10-09T12:00:00.000Z', data: {} };

  function demoApp() {
    const demo = makeDemo('https://localhost:8791');
    const app = createDemoApp({ config: demo.config, store: demo.store, service: demo.service, log: demo.log, logger: demo.logger });
    return { demo, app };
  }

  it('answers a good event at once and acts on it once, even when Perflo sends it again', async () => {
    const { demo, app } = demoApp();
    const acted = vi.spyOn(demo.service, 'onWebhook');
    const first = await postWebhook(app, ping);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });
    const again = await postWebhook(app, ping);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true, duplicate: true });
    expect(acted).toHaveBeenCalledTimes(1);
  });

  it('remembers handled events across a restart, so a retry after a redeploy is not acted on twice', async () => {
    const { demo, app } = demoApp();
    await postWebhook(app, ping);
    const reopened = new Store(demo.dataFile);
    expect(reopened.rememberWebhookEvent('evt_ping_1')).toBe(false);
    expect(reopened.rememberWebhookEvent('evt_ping_2')).toBe(true);
  });

  it('refuses a bad signature, a stale one, and a body whose id is not the header id, and says nothing secret', async () => {
    const { demo, app } = demoApp();
    const acted = vi.spyOn(demo.service, 'onWebhook');
    const wrong = await postWebhook(app, ping, { secret: 'whsec_' + 'y'.repeat(43) });
    expect(wrong.status).toBe(401);
    expect(JSON.stringify(wrong.body)).not.toContain('whsec_');
    const stale = await postWebhook(app, ping, { at: Math.floor(Date.now() / 1000) - 600 });
    expect(stale.status).toBe(401);
    const mismatched = await postWebhook(app, ping, { eventId: 'evt_other' });
    expect(mismatched.status).toBe(400);
    expect(acted).not.toHaveBeenCalled();
    // The operator's log says why, never the secret or the signature.
    const logged = demo.serverLog.join('\n');
    expect(logged).toContain('webhook refused');
    expect(logged).not.toContain(WEBHOOK_SECRET);
  });

  it('needs no session and no Origin (it is server to server), but nothing else under /demo opens without them', async () => {
    const { app } = demoApp();
    expect((await postWebhook(app, { ...ping, id: 'evt_ping_3' })).status).toBe(200);
    expect((await request(app).get('/demo/stream')).status).toBe(401);
  });
});

describe('an order moved on by webhooks alone', () => {
  let server: Server | null = null;
  let mock: { base: string; close: () => Promise<void> } | null = null;
  afterEach(async () => {
    await mock?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = null;
    mock = null;
  });

  it('after the money is added, the card, the checkout and the result reach the page with no further request', async () => {
    // Tiny's server listens for real, so the mock can send its webhooks to it.
    let app: ReturnType<typeof createDemoApp> | null = null;
    server = createServer((req, res) => {
      void (app as ReturnType<typeof createDemoApp>)(req, res);
    });
    await new Promise<void>((done) => (server as Server).listen(0, '127.0.0.1', done));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no port');
    const tiny = `http://127.0.0.1:${address.port}`;
    mock = await startMock(50, { url: `${tiny}${WEBHOOK_PATH}`, secret: WEBHOOK_SECRET });
    const demo = makeDemo(mock.base);
    app = createDemoApp({ config: demo.config, store: demo.store, service: demo.service, log: demo.log, logger: demo.logger });

    // The browser: one session, its own origin on every POST.
    let cookie = '';
    const post = async (path: string, payload: object = {}) => {
      const res = await request(app).post(path).set('Origin', 'https://tiny.test').set('Cookie', cookie).send(payload);
      const set = res.headers['set-cookie'] as unknown as string[] | undefined;
      if (set?.length) cookie = set[0].split(';')[0];
      return res;
    };
    await post('/demo/session');
    // A slow card (over $100 in the mock), so "ready" comes later and only a webhook can bring it.
    const draft = (await post('/demo/chat', { text: 'buy me $150 worth of headphones on amazon' })).body.order as OrderView;
    const setup = (await post(`/demo/orders/${draft.id}/advance`)).body.order as OrderView;
    await finishSetup(mock.base, setup.frameUrl as string);
    await post('/demo/frame-events', {
      type: 'perflo:setup_completed',
      frame_session_id: new URL(setup.frameUrl as string).searchParams.get('session'),
    });
    const due = (await post(`/demo/orders/${draft.id}/advance`)).body.order as OrderView;
    expect(due.phase).toBe('payment_required');

    const stream = await openStream(tiny, cookie);
    const advances = vi.spyOn(demo.service, 'advanceOrder');
    await payInFrame(mock.base, due.frameUrl as string, due.amountDue as string);

    // From here the page sends nothing. Perflo's webhooks move the order; Tiny pays and pushes.
    const pushedPhase = () => stream.messages.flatMap((m) => (m.type === 'order' && m.order.id === draft.id ? [m.order.phase] : [])).at(-1);
    for (let i = 0; i < 100 && pushedPhase() !== 'completed'; i++) await wait(50);
    stream.close();

    expect(pushedPhase()).toBe('completed');
    const stored = demo.store.order(Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0], draft.id);
    expect(stored?.checkout?.outcome).toBe('charged');
    // Every advance after the payment came from a webhook, not from the page.
    expect(advances.mock.calls.length).toBeGreaterThan(0);
    expect(stream.messages.some((m) => m.type === 'log')).toBe(true);
    // Nothing secret went down the feed.
    const fed = JSON.stringify(stream.messages);
    expect(fed).not.toMatch(/ptk_test_|sensitive\?t=|whsec_|[0-9]{16}/);
  }, 15_000);
});

describe('card.closed', () => {
  it('stores the final returned of each order this copy placed and pushes it to the page; another order is logged', async () => {
    const demo = makeDemo('https://localhost:8791');
    const { user } = demo.store.createUser();
    const order = demo.store.createOrder(user.id, { merchantName: 'Shop', domain: 'amazon.com', amountCents: 2000, description: '' });
    demo.store.updateOrder(order, (o) => {
      o.perfloOrderId = 'ord_1';
      o.state = 'placed';
      recordAnswer(o, { order_id: 'ord_1', one_time: false, status: 'completed', amount_spent: '18.00', amount_returned: null });
    });
    expect(toView(order, user).amountReturned).toBeNull();
    const final = { order_id: 'ord_1', one_time: false, status: 'completed', amount_spent: '18.00', amount_returned: '2.40' } as const;
    const read = vi.spyOn(demo.api, 'getOrder').mockResolvedValue(final);
    const pushed = vi.spyOn(demo.service.live, 'send');
    const logged = vi.spyOn(demo.log, 'add');

    await demo.service.onWebhook({
      id: 'evt_closed_1',
      type: 'card.closed',
      created_at: '2026-10-10T12:00:00.000Z',
      data: {
        card_id: 'card_1',
        last4: '4417',
        card_expires_at: '2026-10-10T12:00:00.000Z',
        closed_at: '2026-10-10T12:00:01.000Z',
        orders: [
          { order_id: 'ord_elsewhere', status: 'completed', amount_spent: '1.00', amount_returned: '0.50' },
          { order_id: 'ord_1', status: 'completed', amount_spent: '18.00', amount_returned: '2.40' },
        ],
      },
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(user.id, 'ord_1');
    expect(demo.store.order(user.id, order.id)?.last).toEqual(final);
    expect(pushed).toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({ type: 'order', order: expect.objectContaining({ id: order.id, amountReturned: '2.40' }) }),
    );
    expect(logged).toHaveBeenCalledWith(null, 'webhook', 'card.closed for an order this copy of Tiny did not place', {
      order_id: 'ord_elsewhere',
      event_id: 'evt_closed_1',
    });
  });
});

describe('no polling left', () => {
  const read = (dir: string): Array<{ file: string; text: string }> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? read(join(dir, entry.name))
        : /\.(ts|tsx)$/.test(entry.name)
          ? [{ file: join(dir, entry.name), text: readFileSync(join(dir, entry.name), 'utf8') }]
          : [],
    );

  it('nothing in Tiny runs on a repeating timer except the live feed keepalive (the mock stands in for Perflo)', () => {
    const tabCheck = join('web', 'src', 'browser.ts');
    const offenders = [...read('server'), ...read('web/src')]
      .filter(({ file }) => !file.startsWith(join('server', 'mock')) && file !== join('server', 'live.ts') && file !== tabCheck)
      .filter(({ text }) => /setInterval\(/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
    // The one other timer looks whether the payment tab Tiny opened is still open: the browser's own
    // state, never a request (a tab closed without a word sends nothing).
    const check = read('web/src').find(({ file }) => file === tabCheck)?.text ?? '';
    expect(check).toContain('setInterval(');
    expect(check).not.toMatch(/\bfetch\(|\bapi\.|^import \{[^}]*\} from '\.\/api'/m);
  });

  it('the page never loops reads of an order; the one retry loop left is the cancel, which only repeats the cancel itself', () => {
    const users = read('web/src')
      .filter(({ text }) => /\bpoll\(\{/.test(text))
      .map(({ file }) => file);
    expect(users).toEqual([join('web', 'src', 'cancel.ts')]);
  });
});
