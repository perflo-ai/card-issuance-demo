import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, toBrowserError } from '../server/errors.js';
import { EventLog } from '../server/eventLog.js';
import { PARTNER_ERROR_CODES, PerfloApi, PerfloApiError, PerfloUnavailableError } from '../server/perfloApi.js';
import { DemoError } from '../server/service.js';
import { CREDS, urlOf } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Words a person must never read in an error. */
const TECHNICAL = /\b(http|api|token|signature|idempotency|endpoint|json|null|undefined|stack|[45][0-9]{2})\b/i;

describe('toBrowserError: every failure reaches the browser in plain words with a next step', () => {
  it('maps every documented payments code, without technical words', () => {
    for (const code of PARTNER_ERROR_CODES) {
      const result = toBrowserError(new PerfloApiError(400, code, 'Wait a moment and try again.'));
      expect(result.status, code).toBeGreaterThanOrEqual(400);
      expect(result.message, code).not.toMatch(TECHNICAL);
    }
  });

  it('tells the operator, not the person, when Tiny itself is misconfigured', () => {
    const signature = toBrowserError(new PerfloApiError(401, 'unauthorized', 'We could not confirm who sent this request.'));
    expect(signature.status).toBe(502);
    expect(signature.message).toBe('Payments could not do that right now. Try again in a few minutes.');
    expect(signature.operatorNote).toContain('PARTNER_SECRET');
    // Tiny always sends the amount the person typed, so payments asking for one is Tiny's own bug.
    const noAmount = toBrowserError(new PerfloApiError(422, 'amount_required', 'Say how much money to add.'));
    expect(noAmount.status).toBe(502);
    expect(noAmount.operatorNote).toContain('amount');
    const reused = toBrowserError(new PerfloApiError(409, 'idempotency_key_reused', 'This key was already used.'));
    expect(reused.message).not.toContain('key');
  });

  it('passes the plain message for what the person can act on, with the right status', () => {
    expect(toBrowserError(new PerfloApiError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.'))).toEqual({
      status: 429,
      message: 'Too many requests. Wait a moment and try again.',
    });
    expect(toBrowserError(new PerfloApiError(409, 'card_not_open', 'This card is not open, so there is nothing to show.')).status).toBe(
      409,
    );
    expect(toBrowserError(new PerfloApiError(401, 'user_token_invalid', 'x')).message).toBe(
      'Payments need to be set up again. Send your request once more.',
    );
  });

  it('never passes on an undocumented code or an unexpected error', () => {
    const odd = toBrowserError(new PerfloApiError(418, 'teapot', 'raw upstream text'));
    expect(odd.message).not.toContain('raw upstream text');
    const crash = toBrowserError(new TypeError('cannot read properties of undefined'));
    expect(crash).toMatchObject({ status: 500, message: 'Something went wrong. Try again.' });
    expect(toBrowserError(new PerfloUnavailableError('connect ECONNREFUSED')).message).toBe(
      'Payments are not reachable right now. Try again in a moment.',
    );
    expect(toBrowserError(new DemoError('not_found', 'That order was not found.')).status).toBe(404);
    expect(toBrowserError(new HttpError(403, 'No.')).status).toBe(403);
    expect(toBrowserError(Object.assign(new Error('too big'), { status: 413, type: 'entity.too.large' })).status).toBe(413);
  });
});

describe('PerfloApi retries only reads, and only when told to try again', () => {
  function scripted(answers: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | 'down'>) {
    const calls: string[] = [];
    const fake: typeof fetch = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(urlOf(input)).pathname}`);
      const next = answers.shift();
      if (next === undefined) throw new Error('unscripted');
      if (next === 'down') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status,
        headers: { 'Content-Type': 'application/json', ...next.headers },
      });
    };
    const log = new EventLog();
    return { api: new PerfloApi('https://perflo.test', CREDS, log, fake), calls, log };
  }
  const issuing = { status: 200, body: { order_id: 'ord_1', status: 'issuing' } };

  it('reads again after a lost connection and a 503, honouring Retry-After', async () => {
    vi.useFakeTimers();
    const { api, calls } = scripted(['down', { status: 503, headers: { 'Retry-After': '2' } }, issuing]);
    const answer = api.getOrder('u1', 'ord_1');
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toEqual({ order_id: 'ord_1', status: 'issuing' });
    expect(calls).toEqual(Array(3).fill('GET /v1/checkout/orders/ord_1'));
  });

  it('gives up after three reads', async () => {
    vi.useFakeTimers();
    const { api, calls } = scripted([{ status: 502 }, { status: 502 }, { status: 502 }]);
    const answer = api.getOrder('u1', 'ord_1').catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await answer).toBeInstanceOf(PerfloUnavailableError);
    expect(calls).toHaveLength(3);
  });

  it('does not read again after a refusal that will not change (404)', async () => {
    const { api, calls } = scripted([{ status: 404, body: { error: { code: 'not_found', message: 'We could not find that.' } } }]);
    await expect(api.getOrder('u1', 'ord_1')).rejects.toMatchObject({ code: 'not_found' });
    expect(calls).toHaveLength(1);
  });

  it('never sends a write twice', async () => {
    const { api, calls } = scripted(['down']);
    await expect(api.cancelOrder('u1', 'ord_1', 'ptk_test_token_value')).rejects.toBeInstanceOf(PerfloUnavailableError);
    const busy = scripted([{ status: 503 }]);
    await expect(
      busy.api.createOrder('u1', 'ptk_test_token_value', 'idem-1', {
        user_id: 'usr_1',
        merchant: { name: 'A', domain: 'a.com' },
        amount: '1.00',
        currency: 'USD',
      }),
    ).rejects.toBeInstanceOf(PerfloUnavailableError);
    expect([...calls, ...busy.calls]).toEqual(['POST /v1/checkout/orders/ord_1/cancel', 'POST /v1/checkout/orders']);
  });

  it('a reused card answers null for what went back until it closes, on the order and on the cancel', async () => {
    const open = { order_id: 'ord_1', one_time: false, status: 'completed', amount_spent: '18.00', amount_returned: null };
    const { api } = scripted([
      { status: 200, body: open },
      { status: 200, body: { status: 'cancelled', amount_returned: null } },
      { status: 200, body: { order_id: 'ord_2', one_time: false, status: 'cancelled', amount_returned: null } },
    ]);
    expect(await api.getOrder('u1', 'ord_1')).toEqual(open);
    expect(await api.cancelOrder('u1', 'ord_2', 'ptk_test_token_value')).toEqual({ status: 'cancelled', amount_returned: null });
    expect(await api.getOrder('u1', 'ord_2')).toMatchObject({ status: 'cancelled', amount_returned: null });
  });

  it('a busy cancel is not sent again here, keeps Retry-After for the browser, and logs a repeated refusal once', async () => {
    const unavailable = {
      status: 503,
      body: { error: { code: 'service_unavailable', message: 'This is not available right now. Try again in a moment.' } },
      headers: { 'Retry-After': '7' },
    };
    const { api, calls, log } = scripted([
      unavailable,
      unavailable,
      { status: 200, body: { status: 'cancelled', amount_returned: '5.42' } },
    ]);
    const refused = await api.cancelOrder('u1', 'ord_1', 'ptk_test_token_value').catch((e: unknown) => e);
    expect(refused).toMatchObject({ httpStatus: 503, code: 'service_unavailable', retryAfterSeconds: 7 });
    expect(toBrowserError(refused)).toMatchObject({ status: 503, retryAfterSeconds: 7 });
    await expect(api.cancelOrder('u1', 'ord_1', 'ptk_test_token_value')).rejects.toBeInstanceOf(PerfloApiError);
    expect(await api.cancelOrder('u1', 'ord_1', 'ptk_test_token_value')).toEqual({ status: 'cancelled', amount_returned: '5.42' });
    expect(calls).toHaveLength(3);
    expect(log.forUser('u1').map((e) => e.summary)).toEqual([
      'POST /v1/checkout/orders/ord_1/cancel -> 503',
      'POST /v1/checkout/orders/ord_1/cancel -> 200',
    ]);
  });
});
