/**
 * Request signing for the Perflo Partner API v2.
 *
 * Mirrors perflo-backend-api src/partner/partnerSignature.ts byte for byte
 * (SPEC section 4, corrected 2026-10-07):
 *
 *   canonical = keyVersion \n METHOD \n path \n timestamp \n sha256hex(raw body)
 *   signature = base64url(HMAC-SHA256(secret as utf8, canonical)), unpadded
 *
 * path is the request path WITHOUT the query string; timestamp is the header
 * string exactly as sent, in unix SECONDS. The mock verifies with the same
 * functions, so the wire format lives in one place.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const HEADER_PARTNER_ID = 'X-Partner-Id';
export const HEADER_KEY_VERSION = 'X-Partner-Key-Version';
export const HEADER_TIMESTAMP = 'X-Partner-Timestamp';
export const HEADER_SIGNATURE = 'X-Partner-Signature';

/** Same window as bapi, in seconds, both directions. */
export const SIGNATURE_WINDOW_SECONDS = 120;

export const PARTNER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const KEY_VERSION_PATTERN = /^v[0-9]{1,4}$/;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const TIMESTAMP_PATTERN = /^[0-9]{10,12}$/;

export interface PartnerCredentials {
  partnerId: string;
  keyVersion: string;
  secret: string;
}

export function canonicalRequestString(keyVersion: string, method: string, path: string, timestamp: string, rawBody: Buffer): string {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return `${keyVersion}\n${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
}

export function signCanonicalString(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('base64url');
}

/** Strips any query string, because bapi signs originalUrl without it. */
export function pathWithoutQuery(pathOrUrl: string): string {
  const index = pathOrUrl.indexOf('?');
  return index === -1 ? pathOrUrl : pathOrUrl.slice(0, index);
}

/**
 * The four signature headers for one request. `rawBody` must be the exact
 * bytes that go on the wire (an empty buffer when there is no body).
 */
export function signatureHeaders(
  creds: PartnerCredentials,
  method: string,
  path: string,
  rawBody: Buffer,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const timestamp = String(nowSeconds);
  const message = canonicalRequestString(creds.keyVersion, method, pathWithoutQuery(path), timestamp, rawBody);
  return {
    [HEADER_PARTNER_ID]: creds.partnerId,
    [HEADER_KEY_VERSION]: creds.keyVersion,
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_SIGNATURE]: signCanonicalString(creds.secret, message),
  };
}

export function signaturesMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'base64url');
  const b = Buffer.from(expected, 'base64url');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export type VerifyFailure =
  'header_missing' | 'header_malformed' | 'timestamp_outside_window' | 'partner_unknown' | 'key_version_unknown' | 'mac_invalid';

/**
 * Verification as bapi does it. Used by the mock server only; the demo never
 * receives signed requests in live mode.
 */
export function verifySignature(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  originalUrl: string,
  rawBody: Buffer,
  /** Secrets by key version for a partner, or null when the partner is unknown. */
  lookup: (partnerId: string) => Readonly<Record<string, string>> | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { ok: true; partnerId: string } | { ok: false; reason: VerifyFailure } {
  const id = headers[HEADER_PARTNER_ID.toLowerCase()];
  const keyVersion = headers[HEADER_KEY_VERSION.toLowerCase()];
  const timestamp = headers[HEADER_TIMESTAMP.toLowerCase()];
  const signature = headers[HEADER_SIGNATURE.toLowerCase()];
  if (typeof id !== 'string' || typeof keyVersion !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
    return { ok: false, reason: 'header_missing' };
  }
  if (
    !PARTNER_ID_PATTERN.test(id) ||
    !KEY_VERSION_PATTERN.test(keyVersion) ||
    !TIMESTAMP_PATTERN.test(timestamp) ||
    !SIGNATURE_PATTERN.test(signature)
  ) {
    return { ok: false, reason: 'header_malformed' };
  }
  const sent = Number(timestamp);
  if (!Number.isSafeInteger(sent) || Math.abs(nowSeconds - sent) > SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, reason: 'timestamp_outside_window' };
  }
  const secrets = lookup(id);
  if (secrets === null) {
    return { ok: false, reason: 'partner_unknown' };
  }
  const secret = Object.hasOwn(secrets, keyVersion) ? secrets[keyVersion] : undefined;
  if (secret === undefined) {
    return { ok: false, reason: 'key_version_unknown' };
  }
  const message = canonicalRequestString(keyVersion, method, pathWithoutQuery(originalUrl), timestamp, rawBody);
  if (!signaturesMatch(signature, signCanonicalString(secret, message))) {
    return { ok: false, reason: 'mac_invalid' };
  }
  return { ok: true, partnerId: id };
}
