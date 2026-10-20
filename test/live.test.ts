/**
 * The live feed belongs to the session that opened it, not to an account id: it is closed when that
 * session ends or is rotated, checked again before every message, chosen by nothing in the request
 * but the session cookie, and refused to other sites. Webhook data alone never links, unlinks or
 * wakes a page for someone it does not belong to.
 */
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoApp } from '../server/app.js';
import type { WebhookEvent } from '../server/webhooks.js';
import { CREDS, finishSetup, makeDemo, openStream, startMock, TEST_ORIGIN, wait, WEBHOOK_SECRET } from './helpers.js';

let server: Server | null = null;
let mock: { base: string; close: () => Promise<void> } | null = null;

beforeEach(async () => {
  mock = await startMock(50);
});
afterEach(async () => {
  await mock?.close();
  if (server) {
    // Streams stay open until closed; the server would wait for them.
    server.closeAllConnections();
    await new Promise<void>((done) => (server as Server).close(() => done()));
  }
  server = null;
  mock = null;
});

const mockBase = () => (mock as { base: string }).base;

/** Tiny listening for real (a stream needs a live connection), and browsers that use it. */
async function tiny() {
  const demo = makeDemo(mockBase());
  const app = createDemoApp({ config: demo.config, store: demo.store, service: demo.service, log: demo.log, logger: demo.logger });
  server = createServer((req, res) => {
    void app(req, res);
  });
  await new Promise<void>((done) => (server as Server).listen(0, '127.0.0.1', done));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no port');
  const base = `http://127.0.0.1:${String(address.port)}`;

  const browser = () => {
    let cookie = '';
    const post = async (path: string, body: object = {}) => {
      const res = await request(app).post(path).set('Origin', TEST_ORIGIN).set('Cookie', cookie).send(body);
      const set = res.headers['set-cookie'] as unknown as string[] | undefined;
      if (set?.length) cookie = set[0].split(';')[0];
      return res;
    };
    const userId = () => {
      const user = demo.store.userForSession(cookie.split('=')[1]);
      if (!user) throw new Error('no session');
      return user.id;
    };
    return { post, cookie: () => cookie, userId };
  };
  return { demo, base, browser };
}

describe('the live feed belongs to the session that opened it', () => {
  it('is closed when that session signs out, and nothing for the account reaches it afterwards', async () => {
    const { demo, base, browser } = await tiny();
    const a = browser();
    await a.post('/demo/session');
    const id = a.userId();
    const stream = await openStream(base, a.cookie());
    await a.post('/demo/logout');
    await wait(50);
    expect(stream.closed()).toBe(true);
    expect(demo.service.live.count(id)).toBe(0);
    demo.service.live.send(id, { type: 'log' });
    await wait(50);
    expect(stream.messages).toEqual([]);
  });

  it('on a shared browser, the next person never hears the one before', async () => {
    const { demo, base, browser } = await tiny();
    const tab = browser();
    await tab.post('/demo/session');
    const first = tab.userId();
    const firstStream = await openStream(base, tab.cookie());
    await tab.post('/demo/logout');
    await tab.post('/demo/session');
    const second = tab.userId();
    expect(second).not.toBe(first);
    const secondStream = await openStream(base, tab.cookie());
    demo.service.live.send(first, { type: 'log' });
    demo.service.live.send(second, { type: 'account', linked: false });
    await wait(50);
    expect(firstStream.closed()).toBe(true);
    expect(firstStream.messages).toEqual([]);
    expect(secondStream.messages).toEqual([{ type: 'account', linked: false }]);
    secondStream.close();
  });

  it('is closed when linking rotates the session, so a copy of the old cookie stops hearing the account', async () => {
    const { demo, base, browser } = await tiny();
    const a = browser();
    await a.post('/demo/session');
    const id = a.userId();
    const oldCookie = a.cookie();
    const draft = (await a.post('/demo/chat', { text: 'buy me $5 worth of stickers on amazon' })).body.order as { id: string };
    const setup = (await a.post(`/demo/orders/${draft.id}/advance`)).body.order as { frameUrl: string };
    const copied = await openStream(base, oldCookie);
    await finishSetup(mockBase(), setup.frameUrl);
    const linked = await a.post('/demo/frame-events', {
      type: 'perflo:setup_completed',
      frame_session_id: new URL(setup.frameUrl).searchParams.get('session'),
    });
    expect(linked.body).toEqual({ link: 'linked' });
    expect(a.cookie()).not.toBe(oldCookie);
    await wait(50);
    expect(copied.closed()).toBe(true);
    demo.service.live.send(id, { type: 'log' });
    await wait(50);
    expect(copied.messages).toEqual([]);
    // The page itself opens the feed again with its new cookie and hears its own account.
    const fresh = await openStream(base, a.cookie());
    demo.service.live.send(id, { type: 'account', linked: true });
    await wait(50);
    expect(fresh.messages).toEqual([{ type: 'account', linked: true }]);
    fresh.close();
  });

  it('checks the session again before every message: one that ended elsewhere hears nothing more', async () => {
    const { demo, base, browser } = await tiny();
    const a = browser();
    await a.post('/demo/session');
    const id = a.userId();
    const stream = await openStream(base, a.cookie());
    // The session ends without this stream being told (another process, or the store edited by hand).
    demo.store.endSession(a.cookie().split('=')[1]);
    demo.service.live.send(id, { type: 'log' });
    await wait(50);
    expect(stream.messages).toEqual([]);
    expect(stream.closed()).toBe(true);
  });

  it('is chosen by the session cookie only: ids in the query are ignored', async () => {
    const { demo, base, browser } = await tiny();
    const a = browser();
    const b = browser();
    await a.post('/demo/session');
    await b.post('/demo/session');
    const query = `?user=${b.userId()}&demoUserId=${b.userId()}&external_user_id=${b.userId()}`;
    await expect(openStream(base, '', {}, query)).rejects.toThrow('stream 401');
    const stream = await openStream(base, a.cookie(), {}, query);
    demo.service.live.send(b.userId(), { type: 'log' });
    demo.service.live.send(a.userId(), { type: 'account', linked: false });
    await wait(50);
    expect(stream.messages).toEqual([{ type: 'account', linked: false }]);
    stream.close();
  });

  it('is refused to a request another site started', async () => {
    const { base, browser } = await tiny();
    const a = browser();
    await a.post('/demo/session');
    await expect(openStream(base, a.cookie(), { 'Sec-Fetch-Site': 'cross-site' })).rejects.toThrow('stream 403');
    await expect(openStream(base, a.cookie(), { 'Sec-Fetch-Site': 'same-site' })).rejects.toThrow('stream 403');
    const ok = await openStream(base, a.cookie(), { 'Sec-Fetch-Site': 'same-origin' });
    ok.close();
  });

  it('carries no token, secret or session id, through a whole linked purchase', async () => {
    const { demo, base, browser } = await tiny();
    const a = browser();
    await a.post('/demo/session');
    const id = a.userId();
    const draft = (await a.post('/demo/chat', { text: 'buy me $5 worth of stickers on amazon' })).body.order as { id: string };
    const setup = (await a.post(`/demo/orders/${draft.id}/advance`)).body.order as { frameUrl: string };
    await finishSetup(mockBase(), setup.frameUrl);
    await a.post('/demo/frame-events', {
      type: 'perflo:setup_completed',
      frame_session_id: new URL(setup.frameUrl).searchParams.get('session'),
    });
    await a.post(`/demo/orders/${draft.id}/advance`);
    const stream = await openStream(base, a.cookie());
    const order = demo.store.ordersFor(id).at(0);
    if (!order?.perfloOrderId) throw new Error('order not placed');
    await demo.service.onWebhook({
      id: 'evt_' + 'a'.repeat(32),
      type: 'order.ready',
      created_at: new Date().toISOString(),
      data: { order_id: order.perfloOrderId },
    });
    await wait(50);
    expect(stream.messages.some((m) => m.type === 'order')).toBe(true);
    const sent = JSON.stringify(stream.messages);
    const token = demo.store.user(id).perflo?.token;
    expect(token).toBeTruthy();
    for (const secret of [token as string, CREDS.secret, WEBHOOK_SECRET, a.cookie().split('=')[1]]) {
      expect(sent).not.toContain(secret);
    }
    stream.close();
  });
});

describe('webhook data alone never links, unlinks or wakes someone else', () => {
  let n = 0;
  const event = (type: string, data: Record<string, unknown>): WebhookEvent => ({
    id: `evt_${String(++n).padStart(32, '0')}`,
    type,
    created_at: new Date().toISOString(),
    data,
  });

  it('user.connected wakes a page only while that account waits on a connection', async () => {
    const { demo, base, browser } = await tiny();
    const idle = browser();
    await idle.post('/demo/session');
    const stream = await openStream(base, idle.cookie());
    await demo.service.onWebhook(event('user.connected', { user_id: 'usr_someone', external_user_id: idle.userId() }));
    await wait(50);
    expect(stream.messages).toEqual([]);
    expect(demo.store.user(idle.userId()).perflo).toBeNull();
    stream.close();
  });

  it('user.connected never links by itself: the page links with its own request', async () => {
    const { demo, base, browser } = await tiny();
    const a = browser();
    await a.post('/demo/session');
    const draft = (await a.post('/demo/chat', { text: 'buy me $5 worth of stickers on amazon' })).body.order as { id: string };
    await a.post(`/demo/orders/${draft.id}/advance`);
    expect(demo.store.user(a.userId()).pendingConnection).not.toBeNull();
    const stream = await openStream(base, a.cookie());
    await demo.service.onWebhook(event('user.connected', { user_id: 'usr_someone', external_user_id: a.userId() }));
    await wait(50);
    expect(stream.messages).toContainEqual({ type: 'connected' });
    expect(demo.store.user(a.userId()).perflo).toBeNull();
    stream.close();
  });

  it('user.disconnected for another Perflo person leaves this account linked and its page quiet', async () => {
    const { demo, base, browser } = await tiny();
    const a = browser();
    await a.post('/demo/session');
    demo.store.linkPerflo(a.userId(), { userId: 'usr_real', token: 'ptk_test_' + 'x'.repeat(24) });
    const stream = await openStream(base, a.cookie());
    await demo.service.onWebhook(event('user.disconnected', { user_id: 'usr_other', external_user_id: a.userId() }));
    await wait(50);
    expect(demo.store.user(a.userId()).perflo?.userId).toBe('usr_real');
    expect(stream.messages).toEqual([]);
    stream.close();
  });
});
