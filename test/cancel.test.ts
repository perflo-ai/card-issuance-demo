import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../web/src/api.js';
import { CANCEL_BUDGET_MS, cancelUntilDone, type Cancelled } from '../web/src/cancel.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const busy = () => new ApiError(503, 'Payments could not do that right now.');
const done: Cancelled = { amountReturned: '5.42' };

/** A cancel that answers from a script, and records when (in fake time) each try was sent. */
function scripted(answers: Array<Cancelled | ApiError>) {
  const sentAt: number[] = [];
  const start = Date.now();
  const send = vi.fn(async () => {
    sentAt.push(Date.now() - start);
    const next = answers.shift() ?? busy();
    if (next instanceof ApiError) throw next;
    return next;
  });
  return { send, sentAt };
}

describe('cancelling a card while payments is briefly busy', () => {
  it('regression: 2026-10-09 a 503 then a confirmed cancel ends as cancelled with the money returned', async () => {
    const { send, sentAt } = scripted([busy(), done]);
    const outcome = cancelUntilDone(send);
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ kind: 'cancelled', cancelled: { amountReturned: '5.42' } });
    expect(sentAt).toEqual([0, 3000]);
  });

  it('waits 3, 6, 12, then 20 seconds between tries, and says it is slow after about two minutes', async () => {
    const { send, sentAt } = scripted([]);
    const outcome = cancelUntilDone(send);
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ kind: 'slow' });
    expect(sentAt).toEqual([0, 3000, 9000, 21_000, 41_000, 61_000, 81_000, 101_000, 121_000]);
    expect(sentAt.at(-1)).toBeGreaterThanOrEqual(CANCEL_BUDGET_MS);
  });

  it('treats no answer in time (504) and Tiny not reached (0) as "try again" too', async () => {
    const { send } = scripted([new ApiError(504, 'x'), new ApiError(0, 'x'), done]);
    const outcome = cancelUntilDone(send);
    await vi.runAllTimersAsync();
    expect((await outcome).kind).toBe('cancelled');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('waits at least as long as payments asked (Retry-After)', async () => {
    const { send, sentAt } = scripted([new ApiError(503, 'x', 10_000), done]);
    const outcome = cancelUntilDone(send);
    await vi.runAllTimersAsync();
    expect((await outcome).kind).toBe('cancelled');
    expect(sentAt).toEqual([0, 10_000]);
  });

  it('a refusal that will not change (already finished) is shown at once with its own message, never retried', async () => {
    const { send } = scripted([new ApiError(409, 'This order can no longer be cancelled.')]);
    const outcome = cancelUntilDone(send).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ status: 409, message: 'This order can no longer be cancelled.' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("the browser reads the server's Retry-After into the refusal", async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ error: { message: 'Not available right now.' } }, { status: 503, headers: { 'Retry-After': '7' } }),
    );
    await expect(api.cancelCard('ord_1')).rejects.toMatchObject({ status: 503, retryAfterMs: 7000 });
  });
});
