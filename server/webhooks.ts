/**
 * Perflo webhooks: how Tiny's backend hears that an order or a person changed,
 * instead of asking again and again.
 *
 * HOW A WEBHOOK IS CHECKED. Perflo signs every try with the webhook secret it
 * shows in Builder next to the webhook address (PERFLO_WEBHOOK_SECRET here,
 * never the partner API secret). The signature is HMAC-SHA256, base64url
 * without padding, over these lines joined by a single \n:
 *
 *     perflo-webhook-v1
 *     <X-Perflo-Key>
 *     POST
 *     <the path of the webhook address, no query>
 *     <X-Perflo-Timestamp, unix seconds>
 *     <lower case hex SHA-256 of the raw body>
 *
 * The body is checked exactly as it arrived (no JSON parser runs first), the
 * comparison is constant time, and a timestamp more than two minutes from
 * Tiny's clock (either way) is refused, so a captured webhook cannot be played
 * again later. After the secret is rotated in Builder, Perflo signs every try
 * (retries included) with the new one only: put the new secret in
 * PERFLO_WEBHOOK_SECRET and restart, and the tries refused meanwhile arrive
 * again (Perflo keeps trying for 24 hours). Each try carries the same X-Perflo-Event-Id, which
 * Tiny remembers, so a retry of an event already handled is answered and
 * ignored.
 *
 * WHAT A WEBHOOK MEANS. "Look now". Tiny reads the order again from Perflo
 * (GET is the source of truth) and pushes the result to the person's open
 * pages. The event's own body is only used to know which order or person.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const WEBHOOK_PATH = '/webhooks/perflo';
export const WEBHOOK_SIGNING_CONTEXT = 'perflo-webhook-v1';

export const WEBHOOK_KEY_HEADER = 'x-perflo-key';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-perflo-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'x-perflo-signature';
export const WEBHOOK_EVENT_ID_HEADER = 'x-perflo-event-id';

/** A webhook whose time is further than this from ours (either way) is refused, as Perflo advises. */
export const WEBHOOK_MAX_SKEW_SECONDS = 120;

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TIMESTAMP_PATTERN = /^[0-9]{10,12}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const WEBHOOK_EVENT_TYPES = [
  'order.login_required',
  'order.identity_check_required',
  'order.payment_required',
  'order.ready',
  'order.completed',
  'order.cancelled',
  'order.expired',
  'order.declined',
  'order.failed',
  'user.connected',
  'user.disconnected',
  'card.closed',
  'ping',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/**
 * What Tiny reads from an event: its type and which order or person it is about. Everything else in
 * `data` is ignored on purpose, because the order is read again from Perflo. An event type Tiny does
 * not know is accepted and ignored, so Perflo adding one never makes it retry for a day.
 */
export const webhookEvent = z.object({
  id: opaqueId,
  type: z.string().max(64),
  created_at: z.string().max(64),
  data: z
    .object({
      order_id: opaqueId.optional(),
      user_id: opaqueId.optional(),
      external_user_id: z.string().max(200).nullable().optional(),
    })
    .passthrough(),
});
export type WebhookEvent = z.infer<typeof webhookEvent>;

/**
 * card.closed (a reused card's 12 hours ended): the orders that used the card, newest first. Tiny
 * reads only which orders; each one's final figures are read again from Perflo.
 */
export const cardClosedData = z.object({
  card_id: opaqueId,
  orders: z.array(z.object({ order_id: opaqueId }).passthrough()).max(500),
});

export function webhookCanonicalString(key: string, path: string, timestamp: string, rawBody: Buffer): string {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return `${WEBHOOK_SIGNING_CONTEXT}\n${key}\nPOST\n${path}\n${timestamp}\n${bodyHash}`;
}

export function signWebhook(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('base64url');
}

/** The headers Perflo sends with one try. Used by the mock payments service and the tests. */
export function webhookHeaders(
  secret: string,
  key: string,
  path: string,
  rawBody: Buffer,
  eventId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const timestamp = String(nowSeconds);
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Perflo-Webhooks/1',
    'X-Perflo-Key': key,
    'X-Perflo-Timestamp': timestamp,
    'X-Perflo-Signature': signWebhook(secret, webhookCanonicalString(key, path, timestamp, rawBody)),
    'X-Perflo-Event-Id': eventId,
  };
}

export type WebhookRefusal = 'header_missing' | 'header_malformed' | 'outside_time_window' | 'signature_invalid';

/**
 * Checks one webhook try. `path` is the path it arrived on, without the query. The answer names only
 * why it was refused; nothing secret is in it.
 */
export function verifyWebhook(
  headers: Record<string, string | string[] | undefined>,
  path: string,
  rawBody: Buffer,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { ok: true; eventId: string } | { ok: false; reason: WebhookRefusal } {
  const key = headers[WEBHOOK_KEY_HEADER];
  const timestamp = headers[WEBHOOK_TIMESTAMP_HEADER];
  const signature = headers[WEBHOOK_SIGNATURE_HEADER];
  const eventId = headers[WEBHOOK_EVENT_ID_HEADER];
  if (typeof key !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string' || typeof eventId !== 'string') {
    return { ok: false, reason: 'header_missing' };
  }
  if (
    !KEY_PATTERN.test(key) ||
    !TIMESTAMP_PATTERN.test(timestamp) ||
    !SIGNATURE_PATTERN.test(signature) ||
    !EVENT_ID_PATTERN.test(eventId)
  ) {
    return { ok: false, reason: 'header_malformed' };
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_MAX_SKEW_SECONDS) return { ok: false, reason: 'outside_time_window' };
  const expected = Buffer.from(signWebhook(secret, webhookCanonicalString(key, path, timestamp, rawBody)), 'base64url');
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature_invalid' };
  }
  return { ok: true, eventId };
}
