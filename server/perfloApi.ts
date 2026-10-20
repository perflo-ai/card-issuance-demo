/**
 * Typed, signed client for the Perflo Partner API v2 (SPEC sections 3 and 4).
 *
 * Every request is signed over the exact bytes sent. Responses are validated
 * against the SPEC shapes; anything else is treated as a failure rather than
 * guessed at. The user access token and the secret never leave this server.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { signatureHeaders, type PartnerCredentials } from './signing.js';
import type { EventLog } from './eventLog.js';
import type { lookFields } from './looks.js';
import type { AccountView, DeclineReason as DeclineReasonView, IdentityStatus as IdentityStatusView } from './views.js';

const amount = z.string().regex(/^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/);
/**
 * A link Perflo hands out, which the browser opens or embeds: https only (http
 * only on this computer, for the mock). Anything else, such as a javascript:
 * link, is a broken answer and is refused at the door.
 */
const link = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
  });
const money = z.object({ amount, currency: z.literal('USD') });
/**
 * The `client_secret` Perflo returns beside a page's link: the value Perflo.js opens that page, or its UI
 * elements, with. The same capability the link carries, so it is treated like the link: passed to the
 * person's own page only, never logged (redact.ts). Opaque here; Perflo.js checks its shape. Optional:
 * a Perflo that predates Perflo.js does not send it, and the page then says it cannot open there.
 */
const clientSecret = z.string().regex(/^[A-Za-z0-9_.-]{1,256}$/);

/**
 * The connection an answer names when the user has to connect, or reconnect: its id, and the connect page
 * to open. Perflo sends connect_url as null when it has no page to give; Tiny has nothing to open then, so
 * such an answer is refused like any other outside the contract.
 */
const connectionFields = {
  connection_id: z.string().min(1),
  connect_url: link,
};

export const usersResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved'), user_id: z.string().min(1), user_access_token: z.string().min(1).optional() }),
  z.object({
    status: z.literal('connection_required'),
    ...connectionFields,
    client_secret: clientSecret.optional(),
    expires_at: z.string(),
  }),
]);
export type UsersResponse = z.infer<typeof usersResponse>;

/** GET /v1/connections/{connection_id}. */
export const connectionResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('approved'), user_id: z.string().min(1), user_access_token: z.string().min(1).optional() }),
]);
export type ConnectionResponse = z.infer<typeof connectionResponse>;

export const identityStatus = z.enum(['not_required', 'required', 'pending', 'approved', 'rejected']);
export type IdentityStatus = z.infer<typeof identityStatus>;

export const accountResponse = z.object({
  user_id: z.string(),
  balance: money,
  limits: z.object({
    per_order: money,
    per_month: money,
    spent_this_month: money,
    remaining_this_month: money,
  }),
  identity_check: z.object({ required_above: amount, status: identityStatus }),
  open_cards: z.array(
    z.object({
      order_id: z.string(),
      // The same id the order's ready answer gives; absent from a Perflo that predates it.
      card_id: z.string().optional(),
      last4: z.string(),
      card_limit: amount,
      // Not used: always null.
      expires_at: z.string().nullable(),
    }),
  ),
});
export type AccountResponse = z.infer<typeof accountResponse>;

export const frameLinkResponse = z.object({ frame_url: link, client_secret: clientSecret.optional(), expires_at: z.string() });
/** A page for exactly `amount`: Perflo refuses a top-up with no amount (422 amount_required). */
export const topUpResponse = frameLinkResponse.extend({ top_up_id: z.string(), amount });
export type TopUpResponse = z.infer<typeof topUpResponse>;

export const declineReason = z.enum(['over_order_limit', 'over_monthly_limit', 'partner_limit', 'amount_invalid']);
export type DeclineReason = z.infer<typeof declineReason>;

/**
 * The card mode the order was placed under, on every answer: true for a one-time card, false when the
 * partner reuses one card for the person's orders within its 12 hours. Absent from a Perflo that predates
 * it; Tiny then works the mode out from the cards it was given (web/src/cards.ts).
 */
const orderId = { order_id: z.string(), one_time: z.boolean().optional() };
/**
 * What went back to the person's balance. null while a reused card is still open: its unused money
 * comes back when the card closes, and card.closed then says the final figures. A one-time order always
 * answers a figure. Absent on cancelled and expired from a Perflo that predates it.
 */
const returned = amount.nullable();

export const orderResponse = z.discriminatedUnion('status', [
  z.object({
    ...orderId,
    status: z.literal('ready'),
    card_id: z.string(),
    last4: z.string().regex(/^[0-9]{4}$/),
    card_limit: amount,
    // Present only on the response that first hands the card out (SPEC 4 clarification).
    reveal_url: link.optional(),
    reveal_expires_at: z.string().optional(),
    // Not used: always null.
    card_expires_at: z.string().nullable(),
  }),
  z.object({
    ...orderId,
    status: z.literal('payment_required'),
    frame_url: link,
    // null only when Perflo has no link to give, which frame_url being required already rules out.
    client_secret: clientSecret.nullable().optional(),
    amount_due: amount,
  }),
  z.object({
    ...orderId,
    status: z.literal('connection_required'),
    ...connectionFields,
    client_secret: clientSecret.nullable().optional(),
  }),
  z.object({
    ...orderId,
    status: z.literal('identity_check_required'),
    // null when the link cannot be made right now; absent on an idempotent replay of POST /checkout/orders.
    kyc_url: link.nullable().optional(),
    message: z.string().optional(),
  }),
  z.object({ ...orderId, status: z.literal('issuing') }),
  z.object({ ...orderId, status: z.literal('declined'), reason: declineReason, message: z.string() }),
  z.object({ ...orderId, status: z.literal('completed'), amount_spent: amount, amount_returned: returned }),
  z.object({ ...orderId, status: z.literal('cancelled'), amount_returned: returned.optional() }),
  z.object({ ...orderId, status: z.literal('expired'), amount_returned: returned.optional() }),
  z.object({ ...orderId, status: z.literal('failed') }),
]);
export type OrderResponse = z.infer<typeof orderResponse>;

export const revealLinkResponse = z.object({ reveal_url: link, reveal_expires_at: z.string() });
/** bapi never stores reveal links, so an idempotent replay of card-reveal answers 201 with only a message. */
const revealOrReplay = z.union([revealLinkResponse, z.object({ message: z.string() })]);
export const cancelResponse = z.object({ status: z.literal('cancelled'), amount_returned: returned });

/**
 * Perflo's id for a card linked through Tiny: opaque, the same scheme as its other partner ids. The token
 * the card element hands back for one Save is only known by its prefix (`ctok_...`): any other shape is
 * Perflo's to refuse (card_token_invalid), so Tiny checks only the prefix and the url-safe characters.
 */
export const LINKED_CARD_ID = /^lc_[A-Za-z0-9_-]{22,64}$/;
export const CARD_TOKEN = /^ctok_[A-Za-z0-9_.-]{1,256}$/;
const linkedCardId = z.string().regex(LINKED_CARD_ID);
/** Brand and expiry may be missing on a card the card network did not describe; Tiny shows what is there. */
const linkedCard = z.object({
  id: linkedCardId,
  brand: z.string().nullable(),
  last4: z.string().regex(/^[0-9]{4}$/),
  exp_month: z.number().int().min(1).max(12).nullable(),
  exp_year: z.number().int().min(2000).max(9999).nullable(),
});
export type LinkedCard = z.infer<typeof linkedCard>;

/** POST /users/{id}/linked-cards/form: the card element's client_secret, for 30 minutes. */
export const linkedCardFormResponse = z.object({ client_secret: clientSecret, expires_at: z.string() });

/** 201 linked, or 202 when the card's bank asks the person to confirm inside the card element. */
export const linkCardResponse = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('linked'),
    linked_card: linkedCard,
    auto_top_up: z.object({ status: z.literal('on'), monthly_limit: amount }).nullable(),
  }),
  z.object({ status: z.literal('requires_action'), next_action: z.literal('confirm_in_element') }),
]);
export type LinkCardResponse = z.infer<typeof linkCardResponse>;

export interface LinkCardInput {
  card_token: string;
  auto_top_up: { monthly_limit: string } | null;
}

export const linkedCardsResponse = z.object({
  linked_cards: z.array(linkedCard.extend({ used_for_auto_top_up: z.boolean() })),
});
export type LinkedCardsResponse = z.infer<typeof linkedCardsResponse>;

/** Only where automatic top-ups stand, never why they are paused. */
export const autoTopUpResponse = z.object({
  status: z.enum(['on', 'paused', 'off']),
  monthly_limit: amount.nullable(),
  linked_card_id: linkedCardId.nullable(),
});
export type AutoTopUpResponse = z.infer<typeof autoTopUpResponse>;
const autoTopUpOffResponse = z.object({ status: z.literal('off') });

const errorEnvelope = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** Every refusal code the Partner API v2 documents (perflo-backend-api src/partnerV2/errors.ts). */
export const PARTNER_ERROR_CODES = [
  'invalid_request',
  'unsupported_media_type',
  'request_too_large',
  'unauthorized',
  'user_token_invalid',
  'not_found',
  'rate_limited',
  'code_send_limited',
  'conflict',
  'card_not_open',
  'order_not_cancellable',
  'order_in_progress',
  'user_not_connected',
  'idempotency_key_reused',
  'idempotency_in_progress',
  'idempotency_key_required',
  'frame_expired',
  'frame_step_invalid',
  'connection_failed',
  'wrong_person',
  'email_missing',
  'limits_invalid',
  'amount_invalid',
  'amount_required',
  // Linked cards and automatic top-ups.
  'card_token_invalid',
  'consent_missing',
  'consent_mismatch',
  'monthly_limit_invalid',
  'card_not_supported',
  'card_declined',
  'auto_top_up_already_on',
  'auto_top_up_paused',
  'auto_top_up_unavailable',
  'too_many_attempts',
  'service_unavailable',
  'internal_error',
] as const;
export type PartnerErrorCode = (typeof PARTNER_ERROR_CODES)[number];

/** True when payments refused this person's access token (not Tiny's own signature). */
export function isUserTokenRefused(error: unknown): boolean {
  return error instanceof PerfloApiError && error.code === 'user_token_invalid';
}

export class PerfloApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    /** Seconds payments asked us to wait before trying again (its Retry-After), when it said. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'PerfloApiError';
  }
}

/** The service could not be reached or answered with something outside the contract. */
export class PerfloUnavailableError extends Error {
  /** `retryable`: nothing was answered (no connection or a timeout), so a read may be sent again. */
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PerfloUnavailableError';
  }
}

interface RequestOptions {
  body?: unknown;
  token?: string;
  idempotencyKey?: string;
  /** Overrides the default request timeout. */
  timeoutMs?: number;
  /**
   * Log a repeat of the same answer only once. Always on for reads; for a write that is safe to send
   * again and is retried while it is refused (cancel), so the log shows one line per change.
   */
  collapse?: boolean;
}

/** How the pages a request opens look (server/looks.ts): only ever a fixed example look, never the browser's. */
export type LookFields = ReturnType<typeof lookFields>;

export interface CreateOrderInput extends LookFields {
  user_id: string;
  merchant: { name: string; domain: string };
  amount: string;
  currency: 'USD';
  description?: string;
  external_order_id?: string;
}

const TIMEOUT_MS = 30_000;
/**
 * POST /checkout/orders can wait while Perflo pays for and creates the card (it answers
 * `issuing` past its own budget, about 25 s end to end). Giving up earlier
 * leaves an order that went through looking failed; a retry with the same
 * Idempotency-Key is still safe, it only returns the order.
 */
const ORDER_TIMEOUT_MS = 90_000;
/**
 * Cancelling a ready card waits while Perflo drains and deletes it (about 17 s
 * on 2026-10-08, and Perflo itself waits up to 60 s). A cancel is safe to send
 * again: a cancelled order answers with what was recorded.
 */
const CANCEL_TIMEOUT_MS = 90_000;

/**
 * Reads (GET) are retried when the answer says "try again": the service could not be reached, or
 * answered 429, 502, 503 or 504. Writes are never retried here: an order is retried by reading it
 * (its Idempotency-Key makes a second POST safe, but a read is all a retry needs), and every other
 * write is one the person asked for and can ask for again.
 */
const READ_ATTEMPTS = 3;
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const RETRY_BASE_MS = 500;
const RETRY_MAX_WAIT_MS = 5_000;

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Retry-After as whole seconds (the only form payments may send), or null when absent or unreadable. */
function retryAfterSeconds(retryAfter: string | null): number | null {
  return retryAfter !== null && /^[0-9]{1,4}$/.test(retryAfter) ? Number(retryAfter) : null;
}

/** Retry-After in seconds when payments sent one, else a doubling wait; never more than RETRY_MAX_WAIT_MS. */
function retryWait(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfterSeconds(retryAfter);
  return Math.min(RETRY_MAX_WAIT_MS, seconds !== null ? seconds * 1000 : RETRY_BASE_MS * 2 ** attempt);
}

export class PerfloApi {
  constructor(
    private readonly base: string,
    private readonly credentials: PartnerCredentials,
    private readonly log: EventLog,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(
    demoUserId: string | null,
    method: 'GET' | 'POST' | 'DELETE',
    route: string,
    options: RequestOptions = {},
  ): Promise<{ status: number; json: unknown; retryAfter: string | null }> {
    const attempts = method === 'GET' ? READ_ATTEMPTS : 1;
    for (let attempt = 0; ; attempt++) {
      const last = attempt === attempts - 1;
      try {
        const result = await this.send(demoUserId, method, route, options);
        if (last || !RETRY_STATUSES.has(result.status)) return result;
        await pause(retryWait(attempt, result.retryAfter));
      } catch (error) {
        if (last || !(error instanceof PerfloUnavailableError) || !error.retryable) throw error;
        await pause(retryWait(attempt, null));
      }
    }
  }

  /** One signed request, logged (redacted). Signed fresh each time, so a retry carries a current timestamp. */
  private async send(
    demoUserId: string | null,
    method: 'GET' | 'POST' | 'DELETE',
    route: string,
    options: RequestOptions,
  ): Promise<{ status: number; json: unknown; retryAfter: string | null }> {
    const url = new URL(this.base + route);
    const collapse = method === 'GET' || options.collapse === true;
    // Built once, hashed once, sent as is: the signature covers these exact bytes.
    const rawBody = options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body), 'utf8');
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...signatureHeaders(this.credentials, method, url.pathname, rawBody),
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: rawBody.length > 0 ? rawBody : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not connect';
      this.log.add(demoUserId, 'api', `${method} ${url.pathname} ${reason}`, { request: options.body }, { collapse });
      throw new PerfloUnavailableError(`Payments service ${reason}`, true);
    }

    const text = await response.text();
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        this.log.add(
          demoUserId,
          'api',
          `${method} ${url.pathname} -> ${response.status} (not JSON)`,
          { request: options.body },
          { collapse },
        );
        throw new PerfloUnavailableError('Payments service sent an unreadable answer');
      }
    }
    // A read is often repeated while a status is watched: name the status it answered, and log a
    // repeat of the same answer only once.
    const answered =
      method === 'GET' && typeof (json as { status?: unknown } | null)?.status === 'string'
        ? ` ${(json as { status: string }).status}`
        : '';
    this.log.add(
      demoUserId,
      'api',
      `${method} ${url.pathname} -> ${response.status}${answered}`,
      { request: options.body, response: json },
      { collapse },
    );
    return { status: response.status, json, retryAfter: response.headers.get('retry-after') };
  }

  private parse<T>(schema: z.ZodType<T>, status: number, json: unknown, okStatuses: number[], retryAfter: string | null = null): T {
    if (okStatuses.includes(status)) {
      const parsed = schema.safeParse(json);
      if (parsed.success) return parsed.data;
      throw new PerfloUnavailableError(`Payments service answer did not match the contract (HTTP ${status})`);
    }
    throw this.toError(status, json, retryAfter);
  }

  private toError(status: number, json: unknown, retryAfter: string | null): PerfloApiError | PerfloUnavailableError {
    const parsed = errorEnvelope.safeParse(json);
    if (parsed.success) {
      return new PerfloApiError(status, parsed.data.error.code, parsed.data.error.message, retryAfterSeconds(retryAfter));
    }
    if (status >= 500) return new PerfloUnavailableError(`Payments service error (HTTP ${status})`);
    return new PerfloApiError(status, 'unknown', `Unexpected answer (HTTP ${status})`);
  }

  async createUser(
    demoUserId: string,
    body: { external_user_id: string; reissue?: boolean } & LookFields,
    idempotencyKey?: string,
  ): Promise<UsersResponse> {
    const r = await this.request(demoUserId, 'POST', '/v1/users', { body, ...(idempotencyKey ? { idempotencyKey } : {}) });
    const parsed = this.parse(usersResponse, r.status, r.json, [200, 202]);
    const expected = parsed.status === 'approved' ? 200 : 202;
    if (r.status !== expected) throw new PerfloUnavailableError('Payments service answered with a mismatched status');
    return parsed;
  }

  /** Where a connection stands: pending, expired, or approved (with the token, the first time only). */
  async getConnection(demoUserId: string, connectionId: string): Promise<ConnectionResponse> {
    const r = await this.request(demoUserId, 'GET', `/v1/connections/${encodeURIComponent(connectionId)}`);
    return this.parse(connectionResponse, r.status, r.json, [200]);
  }

  async getAccount(demoUserId: string, userId: string, token: string): Promise<AccountResponse> {
    const r = await this.request(demoUserId, 'GET', `/v1/users/${encodeURIComponent(userId)}`, { token });
    return this.parse(accountResponse, r.status, r.json, [200]);
  }

  async createTopUp(demoUserId: string, userId: string, token: string, amountApi: string, look: LookFields = {}): Promise<TopUpResponse> {
    const r = await this.request(demoUserId, 'POST', `/v1/users/${encodeURIComponent(userId)}/top-ups`, {
      token,
      body: { amount: amountApi, ...look },
    });
    return this.parse(topUpResponse, r.status, r.json, [201]);
  }

  async limitsLink(demoUserId: string, userId: string, token: string, look: LookFields = {}): Promise<z.infer<typeof frameLinkResponse>> {
    // No body at all for the brand default, exactly as before looks existed.
    const r = await this.request(demoUserId, 'POST', `/v1/users/${encodeURIComponent(userId)}/limits-link`, {
      token,
      ...(Object.keys(look).length > 0 ? { body: look } : {}),
    });
    return this.parse(frameLinkResponse, r.status, r.json, [201]);
  }

  /**
   * The card element's page session. No body for the brand default, as for limits-link. The contract does
   * not name the success status; limits-link and top-ups answer 201, so 201 is expected and 200 accepted.
   */
  async linkedCardForm(
    demoUserId: string,
    userId: string,
    token: string,
    look: LookFields = {},
  ): Promise<z.infer<typeof linkedCardFormResponse>> {
    const r = await this.request(demoUserId, 'POST', `/v1/users/${encodeURIComponent(userId)}/linked-cards/form`, {
      token,
      ...(Object.keys(look).length > 0 ? { body: look } : {}),
    });
    return this.parse(linkedCardFormResponse, r.status, r.json, [200, 201], r.retryAfter);
  }

  /**
   * Saves the card behind one card token. Never sent twice here; a retry is the caller's, with the same key.
   * These routes keep Perflo's Retry-After (too_many_attempts, rate_limited) for the browser, as cancel does.
   */
  async linkCard(
    demoUserId: string,
    userId: string,
    token: string,
    idempotencyKey: string,
    body: LinkCardInput,
  ): Promise<LinkCardResponse> {
    const r = await this.request(demoUserId, 'POST', `/v1/users/${encodeURIComponent(userId)}/linked-cards`, {
      token,
      idempotencyKey,
      body,
    });
    const parsed = this.parse(linkCardResponse, r.status, r.json, [201, 202], r.retryAfter);
    const expected = parsed.status === 'linked' ? 201 : 202;
    if (r.status !== expected) throw new PerfloUnavailableError('Payments service answered with a mismatched status');
    return parsed;
  }

  async linkedCards(demoUserId: string, userId: string, token: string): Promise<LinkedCardsResponse> {
    const r = await this.request(demoUserId, 'GET', `/v1/users/${encodeURIComponent(userId)}/linked-cards`, { token });
    return this.parse(linkedCardsResponse, r.status, r.json, [200], r.retryAfter);
  }

  async removeLinkedCard(demoUserId: string, userId: string, token: string, linkedCardId: string): Promise<void> {
    const r = await this.request(
      demoUserId,
      'DELETE',
      `/v1/users/${encodeURIComponent(userId)}/linked-cards/${encodeURIComponent(linkedCardId)}`,
      { token },
    );
    this.parse(z.null(), r.status, r.json, [204], r.retryAfter);
  }

  async autoTopUp(demoUserId: string, userId: string, token: string): Promise<AutoTopUpResponse> {
    const r = await this.request(demoUserId, 'GET', `/v1/users/${encodeURIComponent(userId)}/auto-top-up`, { token });
    return this.parse(autoTopUpResponse, r.status, r.json, [200], r.retryAfter);
  }

  /** Off when already off is a success on Perflo's side too. */
  async turnOffAutoTopUp(demoUserId: string, userId: string, token: string): Promise<void> {
    const r = await this.request(demoUserId, 'DELETE', `/v1/users/${encodeURIComponent(userId)}/auto-top-up`, { token });
    this.parse(autoTopUpOffResponse, r.status, r.json, [200], r.retryAfter);
  }

  /** 201 ready, 202 waiting states and 422 declined are all order answers, not errors. */
  async createOrder(demoUserId: string, token: string, idempotencyKey: string, body: CreateOrderInput): Promise<OrderResponse> {
    const r = await this.request(demoUserId, 'POST', '/v1/checkout/orders', { token, idempotencyKey, body, timeoutMs: ORDER_TIMEOUT_MS });
    return this.parse(orderResponse, r.status, r.json, [201, 202, 422]);
  }

  /** Partner signature only: no token on this route (SPEC 4). */
  async getOrder(demoUserId: string, orderId: string): Promise<OrderResponse> {
    const r = await this.request(demoUserId, 'GET', `/v1/checkout/orders/${encodeURIComponent(orderId)}`);
    return this.parse(orderResponse, r.status, r.json, [200]);
  }

  /**
   * A fresh single-use reveal link. Every call uses a new Idempotency-Key; if the answer is still a
   * replay (a message, no link), it asks once more with another new key.
   */
  async cardReveal(demoUserId: string, orderId: string, token: string): Promise<z.infer<typeof revealLinkResponse>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.request(demoUserId, 'POST', `/v1/checkout/orders/${encodeURIComponent(orderId)}/card-reveal`, {
        token,
        idempotencyKey: randomUUID(),
      });
      const parsed = this.parse(revealOrReplay, r.status, r.json, [201]);
      if ('reveal_url' in parsed) return parsed;
    }
    throw new PerfloUnavailableError('Payments did not hand out a card link');
  }

  /**
   * Not retried here (no write is), but the browser sends it again while payments says it is busy,
   * so a repeat of the same refusal is logged once.
   */
  async cancelOrder(demoUserId: string, orderId: string, token: string): Promise<z.infer<typeof cancelResponse>> {
    const r = await this.request(demoUserId, 'POST', `/v1/checkout/orders/${encodeURIComponent(orderId)}/cancel`, {
      token,
      timeoutMs: CANCEL_TIMEOUT_MS,
      collapse: true,
    });
    return this.parse(cancelResponse, r.status, r.json, [200], r.retryAfter);
  }
}

// The browser-facing copies in views.ts must stay identical to these contract shapes: a difference fails the typecheck.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ContractChecks = [
  Assert<Same<AccountResponse, AccountView>>,
  Assert<Same<DeclineReason, DeclineReasonView>>,
  Assert<Same<IdentityStatus, IdentityStatusView>>,
];
