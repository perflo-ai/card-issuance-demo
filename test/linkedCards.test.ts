import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDemoApp } from '../server/app.js';
import type { DemoConfig } from '../server/config.js';
import { EventLog } from '../server/eventLog.js';
import { createLogger } from '../server/logger.js';
import { PerfloApi } from '../server/perfloApi.js';
import { DemoService, linkCardIdempotencyKey } from '../server/service.js';
import { verifySignature } from '../server/signing.js';
import { Store } from '../server/store.js';
import {
  AUTO_TOP_UP_UNAVAILABLE_TEXT,
  autoTopUpChoice,
  canSave,
  canSendAgain,
  cardProblem,
  MONTHLY_LIMIT_CHOICES,
} from '../web/src/cardForm.js';
import { autoTopUpText, cardSavedText, linkedCardName } from '../web/src/copy.js';
import { LOAD_FAILED_TEXT } from '../web/src/elements.js';
import { CREDS, TEST_HOST, TEST_ORIGIN, urlOf, WEBHOOK_SECRET } from './helpers.js';

const BASE = 'https://perflo.test';
const USER = 'usr_1';
const ACCESS = 'ptk_test_token_value';
const TOKEN_A = 'ctok_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'ctok_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CARD_ID = 'lc_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  signed: boolean;
}
type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** Perflo, scripted: each route answers from its own queue, and every call is recorded with its signature checked. */
function scripted(routes: Record<string, Answer[]>) {
  const calls: Call[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(urlOf(input));
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname}`;
    const headers = Object.fromEntries(Object.entries(init?.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const raw = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.alloc(0);
    const signed = verifySignature(headers, method, url.pathname, raw, () => ({ [CREDS.keyVersion]: CREDS.secret })).ok;
    calls.push({ method, path: url.pathname, headers, body: raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null, signed });
    const next = Object.hasOwn(routes, key) ? routes[key].shift() : undefined;
    if (!next) throw new Error(`unscripted call: ${key}`);
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json', ...next.headers },
    });
  };
  return { fake, calls };
}

async function setup(routes: Record<string, Answer[]>, linked = true) {
  const { fake, calls } = scripted(routes);
  const config: DemoConfig = {
    mode: 'live',
    perfloApiBase: BASE,
    perfloOrigin: BASE,
    credentials: CREDS,
    dataFile: join(mkdtempSync(join(tmpdir(), 'tiny-linked-')), 's.json'),
    listen: { kind: 'local' },
    publicOrigin: TEST_ORIGIN,
    webhookSecret: WEBHOOK_SECRET,
    mockReuseCards: false,
  };
  const log = new EventLog();
  const store = new Store(config.dataFile);
  const service = new DemoService(store, new PerfloApi(BASE, CREDS, log, fake), log, config, fake);
  const logger = createLogger(() => undefined);
  const app = createDemoApp({ config, store, service, log, logger, fetchImpl: fake });
  const started = await request(app).post('/demo/session').set('Host', TEST_HOST).set('Origin', TEST_ORIGIN).send({});
  const cookie = (started.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const user = store.userForSession(cookie.split('=')[1]);
  if (!user) throw new Error('no session');
  if (linked) store.updateUser(user.id, (u) => (u.perflo = { userId: USER, token: ACCESS }));
  const post = (path: string, body: unknown = {}) =>
    request(app)
      .post(path)
      .set('Host', TEST_HOST)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', cookie)
      .send(body as object);
  const get = (path: string) => request(app).get(path).set('Host', TEST_HOST).set('Cookie', cookie);
  return { calls, post, get, log, demoUserId: user.id };
}

const LINKED_ANSWER = {
  status: 'linked',
  linked_card: { id: CARD_ID, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
  auto_top_up: { status: 'on', monthly_limit: '250.00' },
};
const LINK_PATH = `POST /v1/users/${USER}/linked-cards`;
const withLimit = (cardToken: string, monthlyLimit = '250.00') => ({ cardToken, autoTopUp: { monthlyLimit } });

describe('saving a card: one Idempotency-Key per Save, the same one when that Save is tried again', () => {
  it('a Save tried again sends the same key; a new Save (new card token) sends a new one', async () => {
    const { calls, post } = await setup({
      [LINK_PATH]: [
        { status: 201, body: LINKED_ANSWER },
        { status: 201, body: LINKED_ANSWER },
        { status: 201, body: LINKED_ANSWER },
      ],
    });
    const first = await post('/demo/linked-cards', withLimit(TOKEN_A));
    const retry = await post('/demo/linked-cards', withLimit(TOKEN_A));
    const another = await post('/demo/linked-cards', withLimit(TOKEN_B));
    expect([first.status, retry.status, another.status]).toEqual([200, 200, 200]);
    const keys = calls.map((c) => c.headers['idempotency-key']);
    expect(keys[0]).toMatch(/^lc-save-[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    // The key says nothing about the token it came from.
    expect(keys[0]).not.toContain(TOKEN_A.slice('ctok_'.length));
  });

  it('two clicks at once wait for each other and get the same answer, under the same key', async () => {
    const { calls, post } = await setup({
      [LINK_PATH]: [
        { status: 201, body: LINKED_ANSWER },
        { status: 201, body: LINKED_ANSWER },
      ],
    });
    const [a, b] = await Promise.all([post('/demo/linked-cards', withLimit(TOKEN_A)), post('/demo/linked-cards', withLimit(TOKEN_A))]);
    expect(a.body).toEqual(b.body);
    expect(new Set(calls.map((c) => c.headers['idempotency-key'])).size).toBe(1);
  });

  it('the key depends on the account, the token and the choice', () => {
    const base = linkCardIdempotencyKey('u1', TOKEN_A, { monthlyLimit: '250.00' });
    expect(linkCardIdempotencyKey('u1', TOKEN_A, { monthlyLimit: '250.00' })).toBe(base);
    expect(linkCardIdempotencyKey('u2', TOKEN_A, { monthlyLimit: '250.00' })).not.toBe(base);
    expect(linkCardIdempotencyKey('u1', TOKEN_A, { monthlyLimit: '500.00' })).not.toBe(base);
    expect(linkCardIdempotencyKey('u1', TOKEN_A, null)).not.toBe(base);
  });

  it('sends the contract body, signed, with the person’s access token, and answers the browser in its own words', async () => {
    const { calls, post, log, demoUserId } = await setup({ [LINK_PATH]: [{ status: 201, body: LINKED_ANSWER }] });
    const res = await post('/demo/linked-cards', withLimit(TOKEN_A));
    expect(res.body).toEqual({
      status: 'linked',
      linkedCard: { id: CARD_ID, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
      autoTopUp: { status: 'on', monthlyLimit: '250.00' },
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      signed: true,
      body: { card_token: TOKEN_A, auto_top_up: { monthly_limit: '250.00' } },
    });
    expect(calls[0].headers.authorization).toBe(`Bearer ${ACCESS}`);
    // The developer log never keeps the card token.
    expect(JSON.stringify(log.forUser(demoUserId))).not.toContain(TOKEN_A);
  });

  it('the card only: auto_top_up is sent as null', async () => {
    const { calls, post } = await setup({ [LINK_PATH]: [{ status: 201, body: { ...LINKED_ANSWER, auto_top_up: null } }] });
    const res = await post('/demo/linked-cards', { cardToken: TOKEN_A, autoTopUp: null });
    expect(res.body.autoTopUp).toBeNull();
    expect(calls[0].body).toEqual({ card_token: TOKEN_A, auto_top_up: null });
  });

  it('a card its bank wants confirmed reaches the browser as requires_action', async () => {
    const { post } = await setup({
      [LINK_PATH]: [{ status: 202, body: { status: 'requires_action', next_action: 'confirm_in_element' } }],
    });
    const res = await post('/demo/linked-cards', withLimit(TOKEN_A));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'requires_action' });
  });

  it('an answer whose status code disagrees with its body is refused', async () => {
    const { post } = await setup({ [LINK_PATH]: [{ status: 202, body: LINKED_ANSWER }] });
    expect((await post('/demo/linked-cards', withLimit(TOKEN_A))).status).toBe(503);
  });
});

describe('input is checked before anything reaches Perflo', () => {
  const bad: Array<[string, unknown]> = [
    ['no body fields', {}],
    ['autoTopUp left out (null or a limit, never missing)', { cardToken: TOKEN_A }],
    ['a token of another kind', { cardToken: 'pm_123', autoTopUp: null }],
    ['a token with characters no token has', { cardToken: 'ctok_a b<c>', autoTopUp: null }],
    ['a limit without cents', withLimit(TOKEN_A, '250')],
    ['a zero limit', withLimit(TOKEN_A, '0.00')],
    ['a negative limit', withLimit(TOKEN_A, '-5.00')],
    ['a limit as a number', { cardToken: TOKEN_A, autoTopUp: { monthlyLimit: 250 } }],
    ['an extra field', { ...withLimit(TOKEN_A), userId: 'usr_2' }],
    ['an extra field in the choice', { cardToken: TOKEN_A, autoTopUp: { monthlyLimit: '250.00', agreed: true } }],
  ];
  it.each(bad)('refuses %s with 400 and calls nothing', async (_name, body) => {
    const { calls, post } = await setup({});
    const res = await post('/demo/linked-cards', body);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('The card could not be saved. Enter it again and press Save.');
    expect(calls).toHaveLength(0);
  });

  it('refuses a card id that is not Perflo’s, and bodies on routes that take none', async () => {
    const { calls, post } = await setup({});
    expect((await post('/demo/linked-cards/pm_123/remove')).status).toBe(404);
    expect((await post(`/demo/linked-cards/${CARD_ID}/remove`, { force: true })).status).toBe(400);
    expect((await post('/demo/auto-top-up/turn-off', { reason: 'x' })).status).toBe(400);
    expect((await post('/demo/linked-cards/form', { appearance: { theme: 'dark' } })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('a person who has not set up payments is told so, and nothing is sent', async () => {
    const { calls, post, get } = await setup({}, false);
    for (const res of [
      await post('/demo/linked-cards/form'),
      await post('/demo/linked-cards', withLimit(TOKEN_A)),
      await get('/demo/linked-cards'),
      await get('/demo/auto-top-up'),
      await post('/demo/auto-top-up/turn-off'),
      await post(`/demo/linked-cards/${CARD_ID}/remove`),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe('Payments are not set up yet');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('Perflo’s refusals reach the browser as the existing routes pass them', () => {
  const refusal = (status: number, code: string, message: string, headers?: Record<string, string>): Answer => ({
    status,
    body: { error: { code, message } },
    ...(headers ? { headers } : {}),
  });

  it('passes the plain message for what the person can act on, with its status', async () => {
    const cases: Array<[Answer, number, string]> = [
      [
        refusal(402, 'card_declined', 'Your bank declined this card. Try another card.'),
        402,
        'Your bank declined this card. Try another card.',
      ],
      [
        refusal(422, 'card_not_supported', 'This card cannot be used for automatic top-ups.'),
        409,
        'This card cannot be used for automatic top-ups.',
      ],
      [refusal(409, 'auto_top_up_already_on', 'Automatic top-ups are already on.'), 409, 'Automatic top-ups are already on.'],
      [refusal(409, 'auto_top_up_paused', 'Automatic top-ups are paused.'), 409, 'Automatic top-ups are paused.'],
      [refusal(409, 'auto_top_up_unavailable', 'Automatic top-ups are not available.'), 409, 'Automatic top-ups are not available.'],
      [
        refusal(422, 'monthly_limit_invalid', 'Choose a monthly limit between $50.00 and $2,000.00.'),
        400,
        'Choose a monthly limit between $50.00 and $2,000.00.',
      ],
      [refusal(401, 'user_token_invalid', 'x'), 409, 'Payments need to be set up again. Send your request once more.'],
    ];
    for (const [answer, status, message] of cases) {
      const { post } = await setup({ [LINK_PATH]: [answer] });
      const res = await post('/demo/linked-cards', withLimit(TOKEN_A));
      expect([res.status, res.body.error.message]).toEqual([status, message]);
    }
  });

  it('too many tries keeps Perflo’s Retry-After for the browser', async () => {
    const { post } = await setup({
      [LINK_PATH]: [refusal(429, 'too_many_attempts', 'Too many tries. Wait a while and try again.', { 'Retry-After': '30' })],
    });
    const res = await post('/demo/linked-cards', withLimit(TOKEN_A));
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body.error.message).toBe('Too many tries. Wait a while and try again.');
  });

  it('a spent or expired card token asks the person to enter the card again, in Tiny’s words', async () => {
    const { post } = await setup({ [LINK_PATH]: [refusal(422, 'card_token_invalid', 'The card_token is not valid.')] });
    const res = await post('/demo/linked-cards', withLimit(TOKEN_A));
    expect([res.status, res.body.error.message]).toEqual([409, 'That card could not be saved. Enter it again and press Save.']);
  });

  it('an agreement Tiny got wrong is Tiny’s fault: a generic line for the person', async () => {
    for (const code of ['consent_missing', 'consent_mismatch']) {
      const { post } = await setup({ [LINK_PATH]: [refusal(422, code, 'The monthly_limit does not match the consent.')] });
      const res = await post('/demo/linked-cards', withLimit(TOKEN_A));
      expect([res.status, res.body.error.message]).toEqual([502, 'Payments could not do that right now. Try again in a few minutes.']);
    }
  });

  it('the same refusals reach the browser from the other routes', async () => {
    const { post } = await setup({
      [`POST /v1/users/${USER}/linked-cards/form`]: [
        refusal(503, 'service_unavailable', 'This is not available right now. Try again in a moment.'),
      ],
      [`DELETE /v1/users/${USER}/linked-cards/${CARD_ID}`]: [refusal(404, 'not_found', 'We could not find that card.')],
      [`DELETE /v1/users/${USER}/auto-top-up`]: [refusal(429, 'rate_limited', 'Too many requests. Wait a moment and try again.')],
    });
    expect((await post('/demo/linked-cards/form')).status).toBe(503);
    const removed = await post(`/demo/linked-cards/${CARD_ID}/remove`);
    expect([removed.status, removed.body.error.message]).toEqual([404, 'We could not find that card.']);
    expect((await post('/demo/auto-top-up/turn-off')).status).toBe(429);
  });
});

describe('the card element, the list, removing a card and turning automatic top-ups off', () => {
  it('each route calls its contract path, signed, with the access token; remove and turn off are DELETEs', async () => {
    const { calls, post, get } = await setup({
      [`POST /v1/users/${USER}/linked-cards/form`]: [
        { status: 201, body: { client_secret: 'lcs_secret.value', expires_at: '2026-10-20T12:30:00Z' } },
      ],
      [`GET /v1/users/${USER}/linked-cards`]: [
        {
          status: 200,
          body: {
            linked_cards: [
              { id: CARD_ID, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, used_for_auto_top_up: true },
              { id: `${CARD_ID}x`, brand: null, last4: '0005', exp_month: null, exp_year: null, used_for_auto_top_up: false },
            ],
          },
        },
      ],
      [`DELETE /v1/users/${USER}/linked-cards/${CARD_ID}`]: [{ status: 204 }],
      [`GET /v1/users/${USER}/auto-top-up`]: [
        { status: 200, body: { status: 'paused', monthly_limit: '250.00', linked_card_id: CARD_ID } },
      ],
      [`DELETE /v1/users/${USER}/auto-top-up`]: [{ status: 200, body: { status: 'off' } }],
    });
    expect((await post('/demo/linked-cards/form')).body).toEqual({ clientSecret: 'lcs_secret.value' });
    expect((await get('/demo/linked-cards')).body.linkedCards).toEqual([
      { id: CARD_ID, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, usedForAutoTopUp: true },
      { id: `${CARD_ID}x`, brand: null, last4: '0005', expMonth: null, expYear: null, usedForAutoTopUp: false },
    ]);
    expect((await post(`/demo/linked-cards/${CARD_ID}/remove`)).body).toEqual({ ok: true });
    expect((await get('/demo/auto-top-up')).body).toEqual({
      autoTopUp: { status: 'paused', monthlyLimit: '250.00', linkedCardId: CARD_ID },
    });
    expect((await post('/demo/auto-top-up/turn-off')).body).toEqual({ ok: true });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /v1/users/${USER}/linked-cards/form`,
      `GET /v1/users/${USER}/linked-cards`,
      `DELETE /v1/users/${USER}/linked-cards/${CARD_ID}`,
      `GET /v1/users/${USER}/auto-top-up`,
      `DELETE /v1/users/${USER}/auto-top-up`,
    ]);
    for (const call of calls) {
      expect(call.signed, call.path).toBe(true);
      expect(call.headers.authorization, call.path).toBe(`Bearer ${ACCESS}`);
    }
    // The brand default look sends no body at all, as limits-link does; the DELETEs carry none either.
    expect(calls.map((c) => c.body)).toEqual([null, null, null, null, null]);
  });

  it('a removal or a turn off is never sent twice here, even when Perflo is busy', async () => {
    const { calls, post } = await setup({
      [`DELETE /v1/users/${USER}/linked-cards/${CARD_ID}`]: [{ status: 503 }],
      [`DELETE /v1/users/${USER}/auto-top-up`]: [{ status: 503 }],
    });
    expect((await post(`/demo/linked-cards/${CARD_ID}/remove`)).status).toBe(503);
    expect((await post('/demo/auto-top-up/turn-off')).status).toBe(503);
    expect(calls).toHaveLength(2);
  });

  it('reads only the contract’s fields, and refuses an id outside it', async () => {
    const { get } = await setup({
      [`GET /v1/users/${USER}/auto-top-up`]: [
        { status: 200, body: { status: 'on', monthly_limit: '250.00', linked_card_id: CARD_ID, reason: 'fraud' } },
      ],
      [`GET /v1/users/${USER}/linked-cards`]: [
        {
          status: 200,
          body: {
            linked_cards: [{ id: 'pm_123', brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2030, used_for_auto_top_up: false }],
          },
        },
      ],
    });
    // Extra fields are ignored, as zod objects do elsewhere; the pause reason is never passed on.
    expect((await get('/demo/auto-top-up')).body.autoTopUp).toEqual({ status: 'on', monthlyLimit: '250.00', linkedCardId: CARD_ID });
    // A raw payment method id is not a linked card id.
    expect((await get('/demo/linked-cards')).status).toBe(503);
  });
});

describe('the card form on Tiny’s page', () => {
  it('tells the card element about automatic top-ups only when the switch is on and a limit is picked', () => {
    expect(autoTopUpChoice(false, '250.00')).toBeNull();
    expect(autoTopUpChoice(true, '')).toBeNull();
    expect(autoTopUpChoice(true, '250.00')).toEqual({ monthlyLimit: '250.00' });
    // Tiny never picks a limit for the person: with the switch on, Save waits for one.
    expect(canSave(true, '')).toBe(false);
    expect(canSave(true, '500.00')).toBe(true);
    expect(canSave(false, '')).toBe(true);
    expect(MONTHLY_LIMIT_CHOICES.every((amount) => /^[0-9]+\.[0-9]{2}$/.test(amount))).toBe(true);
  });

  it('offers a Save again as it was only when its answer may never have come back', () => {
    expect(canSendAgain(0)).toBe(true);
    expect(canSendAgain(503)).toBe(true);
    for (const status of [400, 402, 409, 429, 502]) expect(canSendAgain(status), String(status)).toBe(false);
  });

  it('says plainly why a card could not be saved', () => {
    expect(cardProblem({ code: 'auto_top_up_unavailable', message: 'auto_top_up is not offered for this partner.' })).toBe(
      AUTO_TOP_UP_UNAVAILABLE_TEXT,
    );
    expect(cardProblem({ code: 'load_failed', message: 'Check the client secret.' })).toBe(LOAD_FAILED_TEXT);
    expect(cardProblem({ code: 'card_incomplete', message: 'Your card number is incomplete.' })).toBe('Your card number is incomplete.');
    expect(cardProblem(undefined)).toBe('Something went wrong. Try again.');
  });

  it('names cards and automatic top-ups in plain words', () => {
    const card = { id: CARD_ID, brand: 'visa', last4: '4242', expMonth: 3, expYear: 2030, usedForAutoTopUp: true };
    expect(linkedCardName(card)).toBe('Visa ending 4242, expires 03/30');
    expect(linkedCardName({ ...card, brand: null, expMonth: null })).toBe('Card ending 4242');
    expect(autoTopUpText({ status: 'on', monthlyLimit: '250.00', linkedCardId: CARD_ID }, [card])).toBe(
      'On, up to $250.00 a month, from the card ending 4242',
    );
    expect(autoTopUpText({ status: 'paused', monthlyLimit: '1000.00', linkedCardId: null }, [])).toBe('Paused, up to $1,000.00 a month');
    expect(autoTopUpText({ status: 'off', monthlyLimit: null, linkedCardId: null }, [card])).toBe('Off');
    expect(cardSavedText('4242', { monthlyLimit: '250.00' })).toBe(
      'Card ending 4242 saved. Automatic top-ups are on, up to $250.00 a month.',
    );
    expect(cardSavedText('4242', null)).toBe('Card ending 4242 saved.');
  });
});
