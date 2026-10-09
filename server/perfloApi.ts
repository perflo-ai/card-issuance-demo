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

export const usersResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved'), user_id: z.string().min(1), user_access_token: z.string().min(1).optional() }),
  z.object({
    status: z.literal('login_required'),
    login_id: z.string().min(1),
    login_url: link,
    expires_at: z.string(),
  }),
]);
export type UsersResponse = z.infer<typeof usersResponse>;

export const loginResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('approved'), user_id: z.string().min(1), user_access_token: z.string().min(1).optional() }),
]);
export type LoginResponse = z.infer<typeof loginResponse>;

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
  open_cards: z.array(z.object({ order_id: z.string(), last4: z.string(), card_limit: amount, expires_at: z.string() })),
});
export type AccountResponse = z.infer<typeof accountResponse>;

export const frameLinkResponse = z.object({ frame_url: link, expires_at: z.string() });
export const topUpResponse = frameLinkResponse.extend({ top_up_id: z.string(), amount: amount.nullable().optional() });
export type TopUpResponse = z.infer<typeof topUpResponse>;

export const declineReason = z.enum(['over_order_limit', 'over_monthly_limit', 'partner_limit', 'amount_invalid']);
export type DeclineReason = z.infer<typeof declineReason>;

export const orderResponse = z.discriminatedUnion('status', [
  z.object({
    order_id: z.string(),
    status: z.literal('ready'),
    card_id: z.string(),
    last4: z.string().regex(/^[0-9]{4}$/),
    card_limit: amount,
    // Present only on the response that first hands the card out (SPEC 4 clarification).
    reveal_url: link.optional(),
    reveal_expires_at: z.string().optional(),
    card_expires_at: z.string(),
  }),
  z.object({ order_id: z.string(), status: z.literal('payment_required'), frame_url: link, amount_due: amount }),
  z.object({ order_id: z.string(), status: z.literal('login_required'), login_id: z.string(), login_url: link }),
  z.object({
    order_id: z.string(),
    status: z.literal('identity_check_required'),
    // null when the link cannot be made right now; absent on an idempotent replay of POST /orders.
    kyc_url: link.nullable().optional(),
    message: z.string().optional(),
  }),
  z.object({ order_id: z.string(), status: z.literal('issuing') }),
  z.object({ order_id: z.string(), status: z.literal('declined'), reason: declineReason, message: z.string() }),
  z.object({ order_id: z.string(), status: z.literal('completed'), amount_spent: amount, amount_returned: amount }),
  z.object({ order_id: z.string(), status: z.literal('cancelled') }),
  z.object({ order_id: z.string(), status: z.literal('expired') }),
  z.object({ order_id: z.string(), status: z.literal('failed') }),
]);
export type OrderResponse = z.infer<typeof orderResponse>;

export const revealLinkResponse = z.object({ reveal_url: link, reveal_expires_at: z.string() });
/** bapi never stores reveal links, so an idempotent replay of card-reveal answers 201 with only a message. */
const revealOrReplay = z.union([revealLinkResponse, z.object({ message: z.string() })]);
export const cancelResponse = z.object({ status: z.literal('cancelled'), amount_returned: amount });

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
  'sign_in_failed',
  'wrong_person',
  'email_missing',
  'limits_invalid',
  'amount_invalid',
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

export interface CreateOrderInput {
  user_id: string;
  merchant: { name: string; domain: string };
  amount: string;
  currency: 'USD';
  description?: string;
  external_order_id?: string;
}

const TIMEOUT_MS = 30_000;
/**
 * POST /orders can wait while Perflo pays for and creates the card (it answers
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
    method: 'GET' | 'POST',
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
    method: 'GET' | 'POST',
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
    body: { external_user_id: string; reissue?: boolean },
    idempotencyKey?: string,
  ): Promise<UsersResponse> {
    const r = await this.request(demoUserId, 'POST', '/partner/v2/users', { body, ...(idempotencyKey ? { idempotencyKey } : {}) });
    const parsed = this.parse(usersResponse, r.status, r.json, [200, 202]);
    const expected = parsed.status === 'approved' ? 200 : 202;
    if (r.status !== expected) throw new PerfloUnavailableError('Payments service answered with a mismatched status');
    return parsed;
  }

  async getLogin(demoUserId: string, loginId: string): Promise<LoginResponse> {
    const r = await this.request(demoUserId, 'GET', `/partner/v2/logins/${encodeURIComponent(loginId)}`);
    return this.parse(loginResponse, r.status, r.json, [200]);
  }

  async getAccount(demoUserId: string, userId: string, token: string): Promise<AccountResponse> {
    const r = await this.request(demoUserId, 'GET', `/partner/v2/users/${encodeURIComponent(userId)}`, { token });
    return this.parse(accountResponse, r.status, r.json, [200]);
  }

  async createTopUp(demoUserId: string, userId: string, token: string, amountApi?: string): Promise<TopUpResponse> {
    const r = await this.request(demoUserId, 'POST', `/partner/v2/users/${encodeURIComponent(userId)}/top-ups`, {
      token,
      body: amountApi === undefined ? {} : { amount: amountApi },
    });
    return this.parse(topUpResponse, r.status, r.json, [201]);
  }

  async limitsLink(demoUserId: string, userId: string, token: string): Promise<z.infer<typeof frameLinkResponse>> {
    const r = await this.request(demoUserId, 'POST', `/partner/v2/users/${encodeURIComponent(userId)}/limits-link`, {
      token,
    });
    return this.parse(frameLinkResponse, r.status, r.json, [201]);
  }

  /** 201 ready, 202 waiting states and 422 declined are all order answers, not errors. */
  async createOrder(demoUserId: string, token: string, idempotencyKey: string, body: CreateOrderInput): Promise<OrderResponse> {
    const r = await this.request(demoUserId, 'POST', '/partner/v2/orders', { token, idempotencyKey, body, timeoutMs: ORDER_TIMEOUT_MS });
    return this.parse(orderResponse, r.status, r.json, [201, 202, 422]);
  }

  /** Partner signature only: no token on this route (SPEC 4). */
  async getOrder(demoUserId: string, orderId: string): Promise<OrderResponse> {
    const r = await this.request(demoUserId, 'GET', `/partner/v2/orders/${encodeURIComponent(orderId)}`);
    return this.parse(orderResponse, r.status, r.json, [200]);
  }

  /**
   * A fresh single-use reveal link. Every call uses a new Idempotency-Key; if the answer is still a
   * replay (a message, no link), it asks once more with another new key.
   */
  async cardReveal(demoUserId: string, orderId: string, token: string): Promise<z.infer<typeof revealLinkResponse>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.request(demoUserId, 'POST', `/partner/v2/orders/${encodeURIComponent(orderId)}/card-reveal`, {
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
    const r = await this.request(demoUserId, 'POST', `/partner/v2/orders/${encodeURIComponent(orderId)}/cancel`, {
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
