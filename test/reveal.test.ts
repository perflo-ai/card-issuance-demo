import { describe, expect, it } from 'vitest';
import { revealCard, RevealError } from '../server/checkout.js';
import { canonicalRequestString, signCanonicalString, verifySignature } from '../server/signing.js';
import { CREDS, urlOf } from './helpers.js';

const LINK = 'https://cards.perflo.test/partner-cards/card_1/sensitive?t=single-use-value';
const TOKEN = 'ptk_test_person_token_value';
const CARD = {
  success: true,
  data: { card_number: '4111111111111111', cvv: '123', exp_month: 10, exp_year: 2029, holder_name: 'A B', last4: '1111' },
};

function scripted(answers: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fake: typeof fetch = async (input, init) => {
    calls.push({ url: urlOf(input), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) } });
    const next = answers.shift();
    if (!next) throw new Error('unscripted');
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { 'Content-Type': 'application/json', ...next.headers },
    });
  };
  return { fake, calls };
}

const auth = { credentials: CREDS, userToken: TOKEN };

describe('revealCard follows the reveal contract (bapi #345, ms-card #94)', () => {
  it('GETs the link exactly as given, signed over GET and its path without the query, with the person token', async () => {
    const { fake, calls } = scripted([{ status: 200, body: CARD }]);
    const card = await revealCard(LINK, auth, fake);
    expect(card).toMatchObject({ number: '4111111111111111', cvv: '123', expMonth: '10', expYear: '2029', last4: '1111' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(LINK);
    expect(call.method).toBe('GET');
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers['X-Partner-Id']).toBe(CREDS.partnerId);
    expect(call.headers['X-Partner-Key-Version']).toBe('v1');
    expect(call.headers['X-Partner-Timestamp']).toMatch(/^[0-9]{10}$/);
    expect(call.headers['X-Partner-Signature']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The canonical string from the contract, by hand: the empty body hashes to e3b0c442...b855.
    const expected = `v1\nGET\n/partner-cards/card_1/sensitive\n${call.headers['X-Partner-Timestamp']}\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
    expect(
      canonicalRequestString('v1', 'GET', '/partner-cards/card_1/sensitive', call.headers['X-Partner-Timestamp'], Buffer.alloc(0)),
    ).toBe(expected);
    expect(call.headers['X-Partner-Signature']).toBe(signCanonicalString(CREDS.secret, expected));
    const lower = Object.fromEntries(Object.entries(call.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(
      verifySignature(lower, 'GET', '/partner-cards/card_1/sensitive?t=single-use-value', Buffer.alloc(0), () => ({ v1: CREDS.secret })).ok,
    ).toBe(true);
  });

  it('a 404 is a refusal: used, expired, or not accepted', async () => {
    const { fake } = scripted([{ status: 404, body: { success: false, error: 'This link has expired or was already used.' } }]);
    await expect(revealCard(LINK, auth, fake)).rejects.toMatchObject({ code: 'used_or_expired' });
  });

  it('a 503 is tried once more after its Retry-After, signed again', async () => {
    const waits: number[] = [];
    const { fake, calls } = scripted([
      { status: 503, headers: { 'Retry-After': '5' } },
      { status: 200, body: CARD },
    ]);
    const card = await revealCard(LINK, auth, fake, async (ms) => {
      waits.push(ms);
    });
    expect(card.last4).toBe('1111');
    expect(waits).toEqual([5000]);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers['X-Partner-Signature']).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('two 503s in a row end with a plain try again, never a third request', async () => {
    const { fake, calls } = scripted([
      { status: 503, headers: { 'Retry-After': '5' } },
      { status: 503, headers: { 'Retry-After': '5' } },
    ]);
    const failure = await revealCard(LINK, auth, fake, async () => undefined).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RevealError);
    expect((failure as RevealError).code).toBe('unavailable');
    expect(calls).toHaveLength(2);
  });

  it('a Retry-After that is missing or too long is bounded', async () => {
    const waits: number[] = [];
    const record = async (ms: number) => {
      waits.push(ms);
    };
    await revealCard(LINK, auth, scripted([{ status: 503 }, { status: 200, body: CARD }]).fake, record);
    await revealCard(
      LINK,
      auth,
      scripted([
        { status: 503, headers: { 'Retry-After': '600' } },
        { status: 200, body: CARD },
      ]).fake,
      record,
    );
    expect(waits).toEqual([5000, 10_000]);
  });

  it('the error never carries the token, the signature or the link', async () => {
    const { fake } = scripted([{ status: 500 }]);
    const failure = (await revealCard(LINK, auth, fake).catch((e: unknown) => e)) as Error;
    const text = `${failure.message} ${failure.stack ?? ''}`;
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('single-use-value');
  });
});
