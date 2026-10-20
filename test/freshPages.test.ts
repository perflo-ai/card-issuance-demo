/**
 * Perflo pages Tiny stores and opens again later (a sign-in, an order's add money page) must still
 * work when the person opens them. A sign-in and its client_secret work for 30 minutes from when
 * Perflo opened them; Tiny checks with Perflo before handing a stored one out again, and opens a new
 * one when Perflo says it is over. Time is moved on the mock's own clock.
 */

import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoApp } from '../server/app.js';
import { PerfloApi } from '../server/perfloApi.js';
import { DemoService } from '../server/service.js';
import type { OrderView, ConnectView } from '../server/views.js';
import { CREDS, finishSetup, frameCall, makeDemo, payInFrame, startMock, urlOf, type LooseJson } from './helpers.js';

const MINUTE = 60_000;

let mock: { base: string; close: () => Promise<void> };
/** How far the mock's clock is ahead of the real one. */
let ahead = 0;
beforeEach(async () => {
  ahead = 0;
  mock = await startMock(50, undefined, false, () => Date.now() + ahead);
});
afterEach(async () => {
  await mock.close();
});

/** Moves the mock's clock forward: the sign-ins and pages it handed out age. */
function later(ms: number) {
  ahead += ms;
}

/**
 * A demo whose calls to Perflo go through `fetchImpl` (to count them, or to make Perflo unreachable),
 * and a browser on it. The session cookie is Secure, so it is carried by hand over plain HTTP.
 */
function demoWith(fetchImpl: typeof fetch = fetch) {
  const demo = makeDemo(mock.base);
  const service = new DemoService(demo.store, new PerfloApi(mock.base, CREDS, demo.log, fetchImpl), demo.log, demo.config);
  const app = createDemoApp({ config: demo.config, store: demo.store, service, log: demo.log, logger: demo.logger });
  let cookie = '';
  const keep = (res: request.Response) => {
    const set = res.headers['set-cookie'] as unknown as string[] | undefined;
    if (set?.length) cookie = set[0].split(';')[0];
    return res;
  };
  const post = async (path: string, body: object = {}) =>
    keep(await request(app).post(path).set('Host', 'tiny.test').set('Origin', 'https://tiny.test').set('Cookie', cookie).send(body));
  return { demo, service, post };
}
type Browser = ReturnType<typeof demoWith>['post'];

/** Every call Tiny made to Perflo, as "METHOD /path". */
function counting() {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(urlOf(input)).pathname}`);
    return fetch(input, init);
  };
  return { calls, fetchImpl };
}

async function signInPage(post: Browser): Promise<{ url: string; clientSecret: string }> {
  const res = await post('/demo/connect');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const body = res.body as ConnectView;
  if (body.link !== 'login_required') throw new Error('expected a sign-in to open');
  return body.page as { url: string; clientSecret: string };
}

/** The page finished the sign-in (email code, then limits) and asks Tiny to look, as the UI elements page does. */
async function finishSignIn(post: Browser, url: string) {
  const done = await finishSetup(mock.base, url);
  expect(done.status).toBe(200);
  expect((await post('/demo/link/refresh')).body).toEqual({ link: 'linked' });
}

async function advance(post: Browser, id: string): Promise<OrderView> {
  const res = await post(`/demo/orders/${id}/advance`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.order as OrderView;
}

async function ask(post: Browser, text: string): Promise<OrderView> {
  return (await post('/demo/chat', { text })).body.order as OrderView;
}

/** A person with payments set up and money in their balance. */
async function linkedWithMoney(post: Browser, amount: string) {
  await post('/demo/session');
  await finishSignIn(post, (await signInPage(post)).url);
  const link = await post('/demo/top-ups', { amount });
  await payInFrame(mock.base, link.body.frameUrl, amount);
}

const pageWorks = async (url: string) => (await frameCall(mock.base, url, 'state')).status;

describe('a stored sign-in is checked before it is handed out again', () => {
  it('past its 30 minutes it is replaced, and Start again gets a sign-in that works to the end', async () => {
    const { post } = demoWith();
    await post('/demo/session');
    const first = await signInPage(post);
    later(31 * MINUTE);
    expect(await pageWorks(first.url)).toBe(410);

    const again = await signInPage(post);
    expect(again.clientSecret).not.toBe(first.clientSecret);
    expect(await pageWorks(again.url)).toBe(200);
    await finishSignIn(post, again.url);
    expect((await post('/demo/connect')).body).toEqual({ link: 'linked' });
  });

  it('two pages opening the sign-in at once make one sign-in, before and after it expires', async () => {
    const { calls, fetchImpl } = counting();
    const { post } = demoWith(fetchImpl);
    await post('/demo/session');
    const [a, b] = await Promise.all([signInPage(post), signInPage(post)]);
    expect(a.clientSecret).toBe(b.clientSecret);
    expect(calls.filter((c) => c === 'POST /v1/users')).toHaveLength(1);

    later(31 * MINUTE);
    const [c, d] = await Promise.all([signInPage(post), signInPage(post)]);
    expect(c.clientSecret).toBe(d.clientSecret);
    expect(c.clientSecret).not.toBe(a.clientSecret);
    expect(calls.filter((call) => call === 'POST /v1/users')).toHaveLength(2);
  });

  it('when Perflo cannot be reached, the person is told to try again, never handed the stored sign-in', async () => {
    let reachable = true;
    const fetchImpl: typeof fetch = (input, init) => {
      if (!reachable) return Promise.reject(new TypeError('fetch failed'));
      return fetch(input, init);
    };
    const { post } = demoWith(fetchImpl);
    await post('/demo/session');
    const first = await signInPage(post);
    reachable = false;
    const res = await post('/demo/connect');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { message: 'Payments are not reachable right now. Try again in a moment.' } });
    expect(JSON.stringify(res.body)).not.toContain(first.clientSecret);
  });
});

describe('an order waiting on a sign-in', () => {
  it('whose sign-in expired gets a new one, and goes through once the person signs in', async () => {
    const { demo, post } = demoWith();
    await linkedWithMoney(post, '100.00');
    expect((await post('/demo/mock/revoke-access')).status).toBe(200);
    const draft = await ask(post, 'buy me $20 worth of books on amazon');
    const blocked = await advance(post, draft.id);
    expect(blocked.phase).toBe('login_required');
    const orders = await signInPage(post);
    expect(orders.clientSecret).toBe(blocked.clientSecret);

    later(31 * MINUTE);
    // Like Perflo, the order keeps naming its own sign-in, past its end.
    const userId = Object.keys(readUsers(demo))[0];
    const read = await demo.api.getOrder(userId, blocked.perfloOrderId as string);
    expect(read).toMatchObject({ status: 'login_required', client_secret: orders.clientSecret });
    expect(await pageWorks(orders.url)).toBe(410);

    const fresh = await signInPage(post);
    expect(fresh.clientSecret).not.toBe(orders.clientSecret);
    await finishSignIn(post, fresh.url);
    expect((await advance(post, draft.id)).phase).toBe('completed');
  });

  it('keeps the new access while Perflo has not moved the order on yet', async () => {
    let stale: LooseJson = null;
    const fetchImpl: typeof fetch = (input, init) => {
      const path = new URL(urlOf(input)).pathname;
      if (stale && (init?.method ?? 'GET') === 'GET' && path === `/v1/checkout/orders/${stale.order_id as string}`) {
        return Promise.resolve(new Response(JSON.stringify(stale), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return fetch(input, init);
    };
    const { demo, post } = demoWith(fetchImpl);
    await linkedWithMoney(post, '100.00');
    await post('/demo/mock/revoke-access');
    const draft = await ask(post, 'buy me $20 worth of books on amazon');
    const blocked = await advance(post, draft.id);
    const userId = Object.keys(readUsers(demo))[0];
    const waiting = await demo.api.getOrder(userId, blocked.perfloOrderId as string);
    later(31 * MINUTE);
    await finishSignIn(post, (await signInPage(post)).url);

    // Perflo moves such an order on by itself, within a minute; until then a read still says login_required.
    stale = waiting;
    const still = await advance(post, draft.id);
    expect(still.phase).toBe('login_required');
    expect((await post('/demo/session')).body.user.linked).toBe(true);
    expect(readUsers(demo)[userId].perflo).not.toBeNull();

    stale = null;
    expect((await advance(post, draft.id)).phase).toBe('completed');
  });
});

describe("an order's add money page", () => {
  it('past its 30 minutes is replaced when the order is read again', async () => {
    const { post } = demoWith();
    await post('/demo/session');
    await finishSignIn(post, (await signInPage(post)).url);
    const draft = await ask(post, 'buy me $20 worth of books on amazon');
    const due = await advance(post, draft.id);
    expect(due.phase).toBe('payment_required');
    later(31 * MINUTE);
    expect(await pageWorks(due.frameUrl as string)).toBe(410);
    const again = await advance(post, draft.id);
    expect(again.phase).toBe('payment_required');
    expect(again.clientSecret).not.toBe(due.clientSecret);
    expect(await pageWorks(again.frameUrl as string)).toBe(200);
  });
});

/** The store file as written: what Tiny keeps across restarts. */
function readUsers(demo: ReturnType<typeof makeDemo>): Record<string, { perflo: unknown }> {
  return (JSON.parse(readFileSync(demo.dataFile, 'utf8')) as { users: Record<string, { perflo: unknown }> }).users;
}
