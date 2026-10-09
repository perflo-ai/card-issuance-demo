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
  open_cards: z.array(
    z.object({ order_id: z.string(), last4: z.string(), card_limit: amount, expires_at: z.string() }),
  ),
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

export class PerfloApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PerfloApiError';
  }
}

/** The service could not be reached or answered with something outside the contract. */
export class PerfloUnavailableError extends Error {
  constructor(message: string) {
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
  ): Promise<{ status: number; json: unknown }> {
    const url = new URL(this.base + route);
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
      this.log.add(demoUserId, 'api', `${method} ${url.pathname} ${reason}`, { request: options.body });
      throw new PerfloUnavailableError(`Payments service ${reason}`);
    }

    const text = await response.text();
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        this.log.add(demoUserId, 'api', `${method} ${url.pathname} -> ${response.status} (not JSON)`, {
          request: options.body,
        });
        throw new PerfloUnavailableError('Payments service sent an unreadable answer');
      }
    }
    // A read is often repeated while a status is watched: name the status it answered, and log a
    // repeat of the same answer only once.
    const answered = method === 'GET' && typeof (json as { status?: unknown } | null)?.status === 'string' ? ` ${(json as { status: string }).status}` : '';
    this.log.add(
      demoUserId,
      'api',
      `${method} ${url.pathname} -> ${response.status}${answered}`,
      { request: options.body, response: json },
      { collapse: method === 'GET' },
    );
    return { status: response.status, json };
  }

  private parse<T>(schema: z.ZodType<T>, status: number, json: unknown, okStatuses: number[]): T {
    if (okStatuses.includes(status)) {
      const parsed = schema.safeParse(json);
      if (parsed.success) return parsed.data;
      throw new PerfloUnavailableError(`Payments service answer did not match the contract (HTTP ${status})`);
    }
    throw this.toError(status, json);
  }

  private toError(status: number, json: unknown): PerfloApiError | PerfloUnavailableError {
    const parsed = errorEnvelope.safeParse(json);
    if (parsed.success) return new PerfloApiError(status, parsed.data.error.code, parsed.data.error.message);
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

  async cancelOrder(demoUserId: string, orderId: string, token: string): Promise<z.infer<typeof cancelResponse>> {
    const r = await this.request(demoUserId, 'POST', `/partner/v2/orders/${encodeURIComponent(orderId)}/cancel`, {
      token,
      timeoutMs: CANCEL_TIMEOUT_MS,
    });
    return this.parse(cancelResponse, r.status, r.json, [200]);
  }
}

// The browser-facing copies in views.ts must stay identical to these contract shapes.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const contractChecks: [Same<AccountResponse, AccountView>, Same<DeclineReason, DeclineReasonView>, Same<IdentityStatus, IdentityStatusView>] = [
  true,
  true,
  true,
];
void contractChecks;
