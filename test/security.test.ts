import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoApp } from '../server/app.js';
import { orderResponse } from '../server/perfloApi.js';
import { rateLimit } from '../server/security.js';
import { finishSetup, makeDemo, startMock } from './helpers.js';

let mock: { base: string; close: () => Promise<void> };
beforeEach(async () => {
  mock = await startMock(50);
});
afterEach(async () => {
  vi.useRealTimers();
  await mock.close();
});

const HOST = 'tiny.test';
const ORIGIN = `https://${HOST}`;
const sessionOf = (res: request.Response) => {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return set?.[0]?.split(';')[0];
};

function app(demo = makeDemo(mock.base), production = false) {
  return {
    demo,
    app: createDemoApp({ config: demo.config, store: demo.store, service: demo.service, log: demo.log, logger: demo.logger, production }),
  };
}

async function startSession(target: ReturnType<typeof app>['app']): Promise<string> {
  const res = await request(target).post('/demo/session').set('Host', HOST).set('Origin', ORIGIN).send({});
  expect(res.status).toBe(200);
  return sessionOf(res) as string;
}

const post = (target: ReturnType<typeof app>['app'], path: string, cookie: string, body: object = {}) =>
  request(target).post(path).set('Host', HOST).set('Origin', ORIGIN).set('Cookie', cookie).send(body);

/** Every route that changes something. Each must refuse a request from another site. */
const STATE_CHANGING = [
  '/demo/session',
  '/demo/logout',
  '/demo/chat',
  '/demo/link/start',
  '/demo/link/refresh',
  '/demo/frame-events',
  '/demo/limits-link',
  '/demo/top-ups',
  '/demo/orders/3f2b8c1e-5d4a-4b6f-9a7c-1e2d3c4b5a69/advance',
  '/demo/orders/3f2b8c1e-5d4a-4b6f-9a7c-1e2d3c4b5a69/discard',
  '/demo/orders/ord_1/card-details',
  '/demo/cards/ord_1/cancel',
  '/demo/mock/revoke-access',
  '/demo/mock/stop-at-checkout',
];

describe('cross-site requests (CSRF and login CSRF)', () => {
  it('refuses every state-changing route from another origin, or with no origin, before doing anything', async () => {
    const { app: target, demo } = app();
    const cookie = await startSession(target);
    const usersBefore = Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users).length;
    for (const path of STATE_CHANGING) {
      const foreign = await request(target)
        .post(path)
        .set('Host', HOST)
        .set('Origin', 'https://evil.example')
        .set('Cookie', cookie)
        .send({});
      expect(foreign.status, path).toBe(403);
      expect(foreign.headers['set-cookie'], path).toBeUndefined();
      const none = await request(target).post(path).set('Host', HOST).set('Cookie', cookie).send({});
      expect(none.status, path).toBe(403);
    }
    // Nothing was created or changed by any of them.
    expect(Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)).toHaveLength(usersBefore);
  });

  it('refuses a same-origin POST that is not JSON (what a plain form sends), even with no body', async () => {
    const { app: target } = app();
    const cookie = await startSession(target);
    const empty = await request(target).post('/demo/link/start').set('Host', HOST).set('Origin', ORIGIN).set('Cookie', cookie);
    expect(empty.status).toBe(415);
    const form = await request(target)
      .post('/demo/logout')
      .set('Host', HOST)
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .type('form')
      .send('a=b');
    expect(form.status).toBe(415);
  });

  it('sets the session cookie HttpOnly, Secure, SameSite=Strict with an expiry', async () => {
    const { app: target } = app();
    const res = await request(target).post('/demo/session').set('Host', HOST).set('Origin', ORIGIN).send({});
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Max-Age=2592000/);
  });

  it('never adopts a session id the request brings: an unknown id gets a new account under a new id', async () => {
    const { app: target } = app();
    const planted = 'tiny_session=attacker-chosen-session-id-value-000000000000';
    const res = await post(target, '/demo/session', planted);
    expect(sessionOf(res)).toBeDefined();
    expect(sessionOf(res)).not.toBe(planted);
  });

  it('a session that ended or expired opens nothing', async () => {
    const { app: target } = app();
    const cookie = await startSession(target);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31 * 24 * 60 * 60_000 });
    expect((await request(target).get('/demo/orders').set('Host', HOST).set('Cookie', cookie)).status).toBe(401);
  });
});

describe('a setup link links only the session that started it', () => {
  it('rotates the session id when the account links, and the old id stops working after a short grace', async () => {
    const { app: target } = app();
    const before = await startSession(target);
    const start = await post(target, '/demo/link/start', before);
    await finishSetup(mock.base, start.body.frameUrl);
    const event = await post(target, '/demo/frame-events', before, {
      type: 'perflo:setup_completed',
      frame_session_id: new URL(start.body.frameUrl).searchParams.get('session') as string,
    });
    expect(event.body).toEqual({ link: 'linked' });
    const after = sessionOf(event);
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect((await post(target, '/demo/session', after as string)).body.user.linked).toBe(true);
    // Within the grace period the old id still works (requests already on their way), then it does not.
    expect((await post(target, '/demo/session', before)).body.user.linked).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    const old = await post(target, '/demo/session', before);
    expect(old.body.user.linked).toBe(false);
  });

  it('a frame event from another session never links this one, whatever ids it carries', async () => {
    const { app: target, demo } = app();
    const alice = await startSession(target);
    const mallory = await startSession(target);
    const aliceStart = await post(target, '/demo/link/start', alice);
    const aliceFrame = aliceStart.body.frameUrl as string;
    await finishSetup(mock.base, aliceFrame);
    // Mallory replays Alice's frame event, ids and all, on her own session.
    const aliceLoginId = Object.values(
      JSON.parse(readFileSync(demo.dataFile, 'utf8')).users as Record<string, { id: string; pendingLogin: { loginId: string } | null }>,
    ).find((u) => u.pendingLogin !== null)?.pendingLogin?.loginId as string;
    const replay = await post(target, '/demo/frame-events', mallory, {
      type: 'perflo:setup_completed',
      frame_session_id: new URL(aliceFrame).searchParams.get('session') as string,
      login_id: aliceLoginId,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.link).not.toBe('linked');
    expect((await post(target, '/demo/session', mallory)).body.user.linked).toBe(false);
    // Alice's own session picks up her login.
    expect((await post(target, '/demo/link/refresh', alice)).body).toEqual({ link: 'linked' });
  });

  it('the setup link and the frame session never reach the log', async () => {
    const { app: target, demo } = app();
    const cookie = await startSession(target);
    const start = await post(target, '/demo/link/start', cookie);
    const frameSession = new URL(start.body.frameUrl).searchParams.get('session') as string;
    await post(target, '/demo/frame-events', cookie, { type: 'perflo:ready', frame_session_id: frameSession });
    const userId = Object.keys(JSON.parse(readFileSync(demo.dataFile, 'utf8')).users)[0];
    const logged = JSON.stringify(demo.log.forUser(userId));
    expect(logged).not.toContain(frameSession);
    expect(logged).not.toContain(start.body.frameUrl);
  });
});

describe('input validation on every route', () => {
  it('refuses unknown ids, unexpected fields and bad queries', async () => {
    const { app: target } = app();
    const cookie = await startSession(target);
    expect((await post(target, '/demo/orders/not-a-uuid/advance', cookie)).status).toBe(404);
    expect((await post(target, '/demo/cards/..%2F..%2Fusers/cancel', cookie)).status).toBe(404);
    expect((await post(target, '/demo/link/start', cookie, { email: 'a@example.com' })).status).toBe(400);
    expect((await post(target, '/demo/chat', cookie, { text: 'hi', extra: true })).status).toBe(400);
    expect((await post(target, '/demo/top-ups', cookie, { amount: '-5' })).status).toBe(400);
    expect((await request(target).get('/demo/events?after=-1').set('Host', HOST).set('Cookie', cookie)).status).toBe(400);
    expect((await request(target).get('/demo/events?after=abc').set('Host', HOST).set('Cookie', cookie)).status).toBe(400);
  });

  it('refuses a link from payments that is not https', () => {
    const answer = { order_id: 'ord_1', status: 'identity_check_required' };
    expect(orderResponse.safeParse({ ...answer, kyc_url: 'javascript:alert(1)' }).success).toBe(false);
    expect(orderResponse.safeParse({ ...answer, kyc_url: 'http://kyc.example/start' }).success).toBe(false);
    expect(orderResponse.safeParse({ ...answer, kyc_url: 'https://kyc.example/start' }).success).toBe(true);
    expect(orderResponse.safeParse({ ...answer, kyc_url: 'http://localhost:8791/mock/kyc' }).success).toBe(true);
  });
});

describe('response headers', () => {
  it('sends the security headers, and the strict content policy when serving the built app', async () => {
    const dev = await request(app().app).get('/demo/config').set('Host', HOST);
    expect(dev.headers['x-content-type-options']).toBe('nosniff');
    expect(dev.headers['x-frame-options']).toBe('DENY');
    expect(dev.headers['referrer-policy']).toBe('no-referrer');
    expect(dev.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(dev.headers['strict-transport-security']).toBeUndefined();

    const built = await request(app(undefined, true).app).get('/demo/config').set('Host', HOST);
    const csp = built.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain(`frame-src ${new URL(mock.base).origin}`);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('marks every demo answer as not to be cached', async () => {
    const { app: target } = app();
    const cookie = await startSession(target);
    const res = await request(target).get('/demo/orders').set('Host', HOST).set('Cookie', cookie);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('rate limit', () => {
  it('answers 429 with Retry-After past the limit, and lets requests through again in the next window', async () => {
    let now = 1_000_000;
    const limit = rateLimit({ windowMs: 60_000, max: 2, now: () => now });
    const statuses: number[] = [];
    const run = () =>
      new Promise<void>((done) => {
        const res = {
          set: () => res,
          status: (code: number) => {
            statuses.push(code);
            return res;
          },
          json: () => done(),
        };
        limit({ ip: '203.0.113.9' } as never, res as never, () => {
          statuses.push(200);
          done();
        });
      });
    await run();
    await run();
    await run();
    now += 60_000;
    await run();
    expect(statuses).toEqual([200, 200, 429, 200]);
  });

  it('limits how many new accounts one address can make', async () => {
    const { app: target } = app();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      codes.push((await request(target).post('/demo/session').set('Host', HOST).set('Origin', ORIGIN).send({})).status);
    }
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
  });
});

describe('operability', () => {
  it('answers the health check without a session, and logs one redacted line per request with its id', async () => {
    const { app: target, demo } = app();
    const health = await request(target).get('/healthz').set('X-Request-Id', 'req_abcdef12');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
    expect(health.headers['x-request-id']).toBe('req_abcdef12');
    const forged = await request(target).get('/healthz').set('X-Request-Id', 'bad id with spaces; and {json}');
    expect(forged.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const cookie = await startSession(target);
    await request(target).get('/demo/events?after=0').set('Host', HOST).set('Cookie', cookie);
    const lines = demo.serverLog.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      level: 'info',
      message: 'request',
      method: 'GET',
      path: '/healthz',
      status: 200,
      request_id: 'req_abcdef12',
    });
    expect(lines.some((l) => l.path === '/demo/events')).toBe(true);
    await request(target).post('/demo/session').set('Host', HOST).set('Origin', 'https://evil.example').send({});
    expect(JSON.parse(demo.serverLog[demo.serverLog.length - 1])).toMatchObject({ path: '/demo/session', status: 403 });
    const all = demo.serverLog.join('\n');
    expect(all).not.toContain('after=');
    expect(all).not.toContain(cookie.split('=')[1]);
  });

  it('without DEMO_PUBLIC_ORIGIN, a POST must come from the host it was sent to', async () => {
    const demo = makeDemo(mock.base);
    demo.config.publicOrigin = null;
    const target = createDemoApp({ config: demo.config, store: demo.store, service: demo.service, log: demo.log, logger: demo.logger });
    const ok = await request(target).post('/demo/session').set('Host', 'tiny.example').set('Origin', 'https://tiny.example').send({});
    expect(ok.status).toBe(200);
    const other = await request(target)
      .post('/demo/session')
      .set('Host', 'tiny.example')
      .set('Origin', 'https://tiny.example.evil.test')
      .send({});
    expect(other.status).toBe(403);
  });
});
