import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalRequestString,
  signatureHeaders,
  signCanonicalString,
  verifySignature,
} from '../server/signing.js';

// Vectors computed independently in Python (hmac + hashlib), following
// perflo-backend-api src/partner/partnerSignature.ts lines 121-135.
const SECRET = 'dGlueS1kZW1vLXNpZ25pbmctdmVjdG9yLXNlY3JldDA';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const PARTNER_ID = '3f2b8c1e-5d4a-4b6f-9a7c-1e2d3c4b5a69';

describe('canonical string and signature', () => {
  it('matches the POST vector', () => {
    const body = Buffer.from('{"user_id":"usr_1","amount":"412.80"}', 'utf8');
    const canonical = canonicalRequestString('v1', 'post', '/partner/v2/orders', '1760000000', body);
    expect(canonical).toBe(
      'v1\nPOST\n/partner/v2/orders\n1760000000\n188118a583ed09127915ed3824c40e660ecb75fa305feac03b8f68cb325fd5c8',
    );
    expect(signCanonicalString(SECRET, canonical)).toBe('oEhT5lgP2_A5mLIPX_q-Ntm4okOeRZDqIpgtMDEv_z4');
  });

  it('signs a GET over an EMPTY body, whose hash is sha256("")', () => {
    const canonical = canonicalRequestString('v2', 'GET', '/partner/v2/orders/ord_abc', '1760000123', Buffer.alloc(0));
    expect(canonical.split('\n')[4]).toBe(EMPTY_SHA256);
    expect(createHash('sha256').update('').digest('hex')).toBe(EMPTY_SHA256);
    expect(signCanonicalString(SECRET, canonical)).toBe('yJVp0Hcm3Dxmon08d2U7-Es88--RGq_JJRCipLlZ0kU');
  });

  it('sends the four bapi headers, timestamp in unix seconds, unpadded base64url', () => {
    const headers = signatureHeaders(
      { partnerId: PARTNER_ID, keyVersion: 'v1', secret: SECRET },
      'POST',
      '/partner/v2/orders?ignored=1',
      Buffer.from('{"user_id":"usr_1","amount":"412.80"}'),
      1760000000,
    );
    expect(headers).toEqual({
      'X-Partner-Id': PARTNER_ID,
      'X-Partner-Key': 'v1',
      'X-Partner-Timestamp': '1760000000',
      // Same as the POST vector: the query string is not signed.
      'X-Partner-Signature': 'oEhT5lgP2_A5mLIPX_q-Ntm4okOeRZDqIpgtMDEv_z4',
    });
    expect(headers['X-Partner-Timestamp']).toMatch(/^[0-9]{10}$/);
  });
});

describe('verification (as bapi does it, used by the mock)', () => {
  const now = 1760000000;
  const body = Buffer.from('{"a":1}');
  const lookup = (id: string) => (id === PARTNER_ID ? { v1: SECRET } : null);
  const sign = (overrides: { secret?: string; keyVersion?: string; at?: number; path?: string; body?: Buffer } = {}) =>
    Object.fromEntries(
      Object.entries(
        signatureHeaders(
          { partnerId: PARTNER_ID, keyVersion: overrides.keyVersion ?? 'v1', secret: overrides.secret ?? SECRET },
          'POST',
          overrides.path ?? '/partner/v2/users',
          overrides.body ?? body,
          overrides.at ?? now,
        ),
      ).map(([k, v]) => [k.toLowerCase(), v]),
    );

  it('accepts a correct request, ignoring the query string', () => {
    expect(verifySignature(sign(), 'POST', '/partner/v2/users?x=1', body, lookup, now)).toEqual({ ok: true, partnerId: PARTNER_ID });
  });

  it.each([
    ['changed body', sign(), '/partner/v2/users', Buffer.from('{"a":2}'), 'mac_invalid'],
    ['changed path', sign(), '/partner/v2/orders', body, 'mac_invalid'],
    ['wrong secret', sign({ secret: 'A'.repeat(43) }), '/partner/v2/users', body, 'mac_invalid'],
    ['stale timestamp', sign({ at: now - 121 }), '/partner/v2/users', body, 'timestamp_outside_window'],
    ['future timestamp', sign({ at: now + 121 }), '/partner/v2/users', body, 'timestamp_outside_window'],
    ['unknown key version', sign({ keyVersion: 'v2' }), '/partner/v2/users', body, 'key_version_unknown'],
  ])('rejects %s', (_name, headers, path, sentBody, reason) => {
    expect(verifySignature(headers, 'POST', path, sentBody as Buffer, lookup, now)).toEqual({ ok: false, reason });
  });

  it('rejects a millisecond timestamp as malformed, like bapi', () => {
    const headers = { ...sign(), 'x-partner-timestamp': String(now * 1000) };
    expect(verifySignature(headers, 'POST', '/partner/v2/users', body, lookup, now)).toEqual({ ok: false, reason: 'header_malformed' });
  });

  it('rejects missing headers and unknown partners', () => {
    const { 'x-partner-signature': _drop, ...partial } = sign();
    expect(verifySignature(partial, 'POST', '/partner/v2/users', body, lookup, now)).toEqual({ ok: false, reason: 'header_missing' });
    expect(verifySignature(sign(), 'POST', '/partner/v2/users', body, () => null, now)).toEqual({ ok: false, reason: 'partner_unknown' });
  });

  it('a GET signed by the client verifies with an empty captured body', () => {
    const headers = Object.fromEntries(
      Object.entries(
        signatureHeaders({ partnerId: PARTNER_ID, keyVersion: 'v1', secret: SECRET }, 'GET', '/partner/v2/logins/lg_1', Buffer.alloc(0), now),
      ).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(verifySignature(headers, 'GET', '/partner/v2/logins/lg_1', Buffer.alloc(0), lookup, now).ok).toBe(true);
  });
});
