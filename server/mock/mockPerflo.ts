/**
 * Local mock of the Perflo Partner API v2 (SPEC sections 3, 4, 8 and 8a, with
 * the 2026-10-07 clarifications), for DEMO_MODE=mock. It verifies partner
 * signatures exactly like bapi, keeps state in memory, and serves simple frame
 * pages that send the same postMessage events. Nothing here is real money.
 *
 * Mock-only additions, outside the partner contract and never called by the
 * partner client code paths except where noted:
 *   POST /mock-stripe/pay            stands in for Stripe inside the add money frame
 *   POST /mock-merchant/checkout     a shop that charges a one-time card (demo checkout, mock mode)
 *   GET|POST /mock/kyc               an identity check page (kyc_url)
 *   POST /mock/control/revoke        simulates the person turning off Tiny's access
 *   GET  /mock-relay/partner-cards/:cardId/sensitive   the reveal link (already decrypted), signed and with
 *                                                     the person's Bearer token, as the real one requires
 *
 * Card mode: one card per order by default, like a partner with `one_time = true`. With `reuseCards`
 * set it answers like a partner in reuse mode: a person's later orders go onto their open card (no card
 * fee), money stays on the card when an order is paid, cancelling one order leaves the card open for the
 * others, and the card closes at its 12 hours, returning what is left.
 *
 * Webhooks: with `webhook` set, the mock tells the partner's backend about every order and person
 * status change, signed exactly as Perflo signs them, retried when the partner does not answer 2xx.
 * Like Perflo's own sweep, it also moves orders on by itself (a slow card becoming ready, an order
 * resuming once money arrived), so nothing has to ask it again and again.
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { centsToApiAmount, isApiAmount, apiAmountToCents } from '../money.js';
import { verifySignature } from '../signing.js';
import { webhookHeaders } from '../webhooks.js';
import { frameAssets, framePage, kycPage } from './mockPages.js';

export const MOCK_CODE = '123456';
export const MOCK_BRAND = 'Tiny';
const FRAME_TTL_MS = 30 * 60_000;
const LOGIN_TTL_MS = 30 * 60_000;
const CARD_TTL_MS = 12 * 60 * 60_000;
const REVEAL_TTL_MS = 900_000;
const NO_KYC_LIMIT_CENTS = 20_000;
const MONTH_MS = 30 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Largest single card (bapi answers amount_invalid above it). */
const MAX_CARD_CENTS = 250_000;
/** Mock partner-wide cap over a rolling 24 hours. The real value is not decided (SPEC 1). */
const MOCK_PARTNER_DAILY_CAP_CENTS = 1_000_000;
/** Orders above this amount answer `issuing` first, so that state can be demonstrated. */
export const MOCK_SLOW_ISSUE_ABOVE_CENTS = 10_000;
const MAX_TOP_UP_CENTS = 1_000_000;

// SPEC 1 and 6.3: spend fee 3.3% + $0.25, minimum load $15, card fee $1.
export function quote(orderCents: number): { loadCents: number; cardFeeCents: number; totalCents: number } {
  const loadCents = Math.max(1500, Math.ceil((orderCents * 1033) / 1000) + 25);
  return { loadCents, cardFeeCents: 100, totalCents: loadCents + 100 };
}

const id = (prefix: string, bytes = 12) => `${prefix}${randomBytes(bytes).toString('base64url')}`;

interface Grant {
  perOrderCents: number;
  perMonthCents: number;
}

interface MUser {
  userId: string;
  externalUserId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  grant: Grant | null;
  token: string | null;
  balanceCents: number;
  kycApproved: boolean;
  kycRef: string;
}

interface MLogin {
  loginId: string;
  userId: string;
  status: 'pending' | 'approved';
  tokenDelivered: boolean;
  expiresAt: number;
  frameId: string;
  orderId: string | null;
}

type Purpose = 'setup' | 'top-up' | 'limits';
type Step = 'login' | 'limits' | 'top_up' | 'done';

interface MFrame {
  id: string;
  purpose: Purpose;
  userId: string;
  loginId: string | null;
  orderId: string | null;
  amountCents: number | null;
  step: Step;
  loggedIn: boolean;
  topUpId: string | null;
  expiresAt: number;
}

interface MCard {
  cardId: string;
  number: string;
  cvv: string;
  expMonth: string;
  expYear: string;
  last4: string;
  expiresAt: number;
  /** Reuse mode: the card serves every order of the person until it closes at expiresAt. */
  reusable: boolean;
  /** Closed: no order can use it any more (a one-time card once its order ends, any card at expiresAt). */
  closed: boolean;
}

type OrderStatus =
  | 'awaiting_login'
  | 'awaiting_payment'
  | 'identity_check_required'
  | 'issuing'
  | 'ready'
  | 'declined'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed';

interface MOrder {
  orderId: string;
  userId: string;
  merchant: { name: string; domain: string };
  amountCents: number;
  status: OrderStatus;
  createdAt: number;
  /** Shared by several orders in reuse mode. */
  card: MCard | null;
  /** What this order put on the card (its own top-up). */
  loadCents: number;
  /** What the shop's charge took from the card, fees included. */
  usedCents: number;
  readyAt: number | null;
  loginId: string | null;
  frameId: string | null;
  declined: { reason: string; message: string } | null;
  spentCents: number;
  returnedCents: number;
}

interface MTopUp {
  topUpId: string;
  frameId: string;
  userId: string;
  amountCents: number;
  clientSecret: string;
  paid: boolean;
}

export interface MockOptions {
  partnerId: string;
  keyVersion: string;
  secret: string;
  /** This mock's own origin, used in the links it hands out. */
  selfOrigin: string;
  /** The partner website allowed to embed frames and receive postMessage. */
  partnerOrigin: string;
  slowIssueMs?: number;
  /** Answer as a partner in reuse mode (one card per person for its 12 hours). Default: one card per order. */
  reuseCards?: boolean;
  /** Where to send webhooks and the secret to sign them with. Unset: no webhooks are sent. */
  webhook?: { url: string; secret: string; fetchImpl?: typeof fetch };
}

/** How often the mock moves orders on by itself and announces changes (stands in for bapi's sweep). */
const MOCK_SWEEP_MS = 500;
/** Waits before each new try of a webhook the partner did not accept, like Perflo (but in seconds). */
const MOCK_WEBHOOK_RETRY_MS = [1_000, 5_000, 15_000];
const MOCK_WEBHOOK_TIMEOUT_MS = 10_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const amountString = z.string().refine(isApiAmount, 'amount must have two decimal places');

export function createMockPerflo(options: MockOptions) {
  const slowIssueMs = options.slowIssueMs ?? 3000;
  const users = new Map<string, MUser>();
  const tokens = new Map<string, string>();
  /** Tokens whose grant the person revoked: orders with them answer login_required (SPEC 4). */
  const revokedTokens = new Map<string, string>();
  const logins = new Map<string, MLogin>();
  const frames = new Map<string, MFrame>();
  const orders = new Map<string, MOrder>();
  const topUps = new Map<string, MTopUp>();
  const reveals = new Map<string, { orderId: string; expiresAt: number; consumed: boolean }>();
  const idempotency = new Map<string, { bodyHash: string; status: number; body: unknown }>();
  const userReplays = new Map<string, { status: number; body: Record<string, unknown> }>();
  const revealKeys = new Set<string>();
  const spends: Array<{ userId: string; at: number; cents: number }> = [];

  const frameUrl = (purpose: Purpose, frameId: string) =>
    `${options.selfOrigin}/partner/v2/frames/${purpose}?session=${encodeURIComponent(frameId)}`;

  function newFrame(purpose: Purpose, userId: string, extra: Partial<MFrame> = {}): MFrame {
    const frame: MFrame = {
      id: `fs_${randomBytes(32).toString('base64url')}`,
      purpose,
      userId,
      loginId: null,
      orderId: null,
      amountCents: null,
      step: purpose === 'setup' ? 'login' : purpose === 'limits' ? 'limits' : 'top_up',
      loggedIn: false,
      topUpId: null,
      expiresAt: Date.now() + FRAME_TTL_MS,
      ...extra,
    };
    frames.set(frame.id, frame);
    return frame;
  }

  function newLogin(user: MUser, orderId: string | null): MLogin {
    const loginId = id('lg_');
    const frame = newFrame('setup', user.userId, { loginId, orderId });
    const login: MLogin = {
      loginId,
      userId: user.userId,
      status: 'pending',
      tokenDelivered: false,
      expiresAt: Date.now() + LOGIN_TTL_MS,
      frameId: frame.id,
      orderId,
    };
    logins.set(loginId, login);
    return login;
  }

  function mintToken(user: MUser): string {
    if (user.token) tokens.delete(user.token);
    const token = id('ptk_test_', 24);
    user.token = token;
    tokens.set(token, user.userId);
    return token;
  }

  const monthSpent = (userId: string) =>
    spends.filter((s) => s.userId === userId && s.at > Date.now() - MONTH_MS).reduce((sum, s) => sum + s.cents, 0);
  const partnerDaySpent = () => spends.filter((s) => s.at > Date.now() - DAY_MS).reduce((sum, s) => sum + s.cents, 0);
  const cardSpendTotal = (userId: string) =>
    [...orders.values()]
      .filter((o) => o.userId === userId && (o.status === 'issuing' || o.status === 'ready' || o.status === 'completed'))
      .reduce((sum, o) => sum + o.amountCents, 0);

  /** The person's card that a new order goes onto in reuse mode: open, and not yet at its 12 hours. */
  function reusableCard(userId: string): MCard | null {
    for (const o of orders.values()) {
      if (o.userId === userId && o.card?.reusable && !o.card.closed && o.card.expiresAt > Date.now()) return o.card;
    }
    return null;
  }

  function newCard(): MCard {
    const number = `4${String(randomInt(0, 10 ** 9)).padStart(9, '0')}${String(randomInt(0, 10 ** 6)).padStart(6, '0')}`;
    const expiry = new Date(Date.now() + 3 * 365 * DAY_MS);
    return {
      cardId: id('card_'),
      number,
      cvv: String(randomInt(100, 1000)),
      expMonth: String(expiry.getUTCMonth() + 1).padStart(2, '0'),
      expYear: String(expiry.getUTCFullYear()),
      last4: number.slice(-4),
      expiresAt: Date.now() + CARD_TTL_MS,
      reusable: options.reuseCards === true,
      closed: false,
    };
  }

  /**
   * A card reaches its 12 hours: every order still open on it expires with its money back, and a paid
   * order on a reused card gets back what its charge left on the card.
   */
  function closeCard(card: MCard): void {
    card.closed = true;
    for (const o of orders.values()) {
      if (o.card !== card || !(o.status === 'ready' || (o.status === 'completed' && card.reusable))) continue;
      const back = o.status === 'ready' ? o.loadCents : Math.max(0, o.loadCents - o.usedCents);
      if (o.status === 'ready') o.status = 'expired';
      o.returnedCents = back;
      (users.get(o.userId) as MUser).balanceCents += back;
    }
  }

  /** The checks bapi runs on place and on resume, in SPEC 4 order. */
  function evaluate(order: MOrder): void {
    const user = users.get(order.userId) as MUser;
    if (!user.grant || !user.token) {
      if (order.status !== 'awaiting_login' || !order.loginId || !isLoginLive(order.loginId)) {
        order.loginId = newLogin(user, order.orderId).loginId;
      }
      order.status = 'awaiting_login';
      return;
    }
    const decline = (reason: string, message: string) => {
      order.status = 'declined';
      order.declined = { reason, message };
    };
    if (order.amountCents > user.grant.perOrderCents) {
      return decline('over_order_limit', 'This is more than you allow Tiny to spend on one order.');
    }
    if (monthSpent(user.userId) + order.amountCents > user.grant.perMonthCents) {
      return decline('over_monthly_limit', 'This would go over what you allow Tiny to spend each month.');
    }
    if (partnerDaySpent() + order.amountCents > MOCK_PARTNER_DAILY_CAP_CENTS) {
      return decline('partner_limit', 'Tiny has reached its spending limit for today. Try again tomorrow.');
    }
    if (!user.kycApproved && cardSpendTotal(user.userId) + order.amountCents > NO_KYC_LIMIT_CENTS) {
      order.status = 'identity_check_required';
      return;
    }
    const reused = options.reuseCards ? reusableCard(user.userId) : null;
    const price = quote(order.amountCents);
    // A reused card is topped up for this order; only a new card costs the card fee.
    const totalCents = reused ? price.loadCents : price.totalCents;
    if (user.balanceCents < totalCents) {
      const due = totalCents - user.balanceCents;
      const current = order.frameId ? frames.get(order.frameId) : undefined;
      if (!current || current.expiresAt < Date.now() || current.step === 'done' || current.amountCents !== due) {
        order.frameId = newFrame('top-up', user.userId, { orderId: order.orderId, amountCents: due }).id;
      }
      order.status = 'awaiting_payment';
      return;
    }
    user.balanceCents -= totalCents;
    spends.push({ userId: user.userId, at: Date.now(), cents: order.amountCents });
    order.loadCents = price.loadCents;
    order.card = reused ?? newCard();
    if (order.amountCents > MOCK_SLOW_ISSUE_ABOVE_CENTS) {
      order.status = 'issuing';
      order.readyAt = Date.now() + slowIssueMs;
    } else {
      order.status = 'ready';
    }
  }

  function isLoginLive(loginId: string): boolean {
    const login = logins.get(loginId);
    return !!login && login.status === 'pending' && login.expiresAt > Date.now();
  }

  /** Time-driven changes, applied whenever an order is read (stands in for bapi's sweep and ms-card's cron). */
  function refresh(order: MOrder): void {
    if (order.status === 'issuing' && order.readyAt !== null && Date.now() >= order.readyAt) {
      order.status = 'ready';
    }
    if (order.card && !order.card.closed && Date.now() > order.card.expiresAt) closeCard(order.card);
    if (order.status === 'awaiting_payment' || order.status === 'identity_check_required' || order.status === 'awaiting_login') {
      if (Date.now() - order.createdAt < DAY_MS) evaluate(order);
    }
  }

  function revealLink(order: MOrder): { reveal_url: string; reveal_expires_at: string } {
    const card = order.card as MCard;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + REVEAL_TTL_MS;
    reveals.set(token, { orderId: order.orderId, expiresAt, consumed: false });
    return {
      reveal_url: `${options.selfOrigin}/mock-relay/partner-cards/${card.cardId}/sensitive?t=${token}`,
      reveal_expires_at: new Date(expiresAt).toISOString(),
    };
  }

  /** The public order shape (SPEC 4). `withReveal` only on the answer that first hands the card out. */
  function present(order: MOrder, withReveal: boolean): { status: number; body: Record<string, unknown> } {
    const base = { order_id: order.orderId };
    switch (order.status) {
      case 'ready': {
        const card = order.card as MCard;
        return {
          status: 201,
          body: {
            ...base,
            status: 'ready',
            card_id: card.cardId,
            last4: card.last4,
            card_limit: centsToApiAmount(order.amountCents),
            card_expires_at: new Date(card.expiresAt).toISOString(),
            ...(withReveal ? revealLink(order) : {}),
          },
        };
      }
      case 'awaiting_payment': {
        const frame = frames.get(order.frameId as string) as MFrame;
        return {
          status: 202,
          body: {
            ...base,
            status: 'payment_required',
            frame_url: frameUrl('top-up', frame.id),
            amount_due: centsToApiAmount(frame.amountCents as number),
          },
        };
      }
      case 'awaiting_login': {
        const login = logins.get(order.loginId as string) as MLogin;
        return {
          status: 202,
          body: { ...base, status: 'login_required', login_id: login.loginId, login_url: frameUrl('setup', login.frameId) },
        };
      }
      case 'identity_check_required': {
        const user = users.get(order.userId) as MUser;
        return {
          status: 202,
          // null when the link cannot be made (no verified email yet).
          body: {
            ...base,
            status: 'identity_check_required',
            kyc_url: user.email ? `${options.selfOrigin}/mock/kyc?ref=${user.kycRef}` : null,
          },
        };
      }
      case 'issuing':
        return { status: 202, body: { ...base, status: 'issuing' } };
      case 'declined':
        return { status: 422, body: { ...base, status: 'declined', ...(order.declined as object) } };
      case 'completed':
        return {
          status: 200,
          body: {
            ...base,
            status: 'completed',
            amount_spent: centsToApiAmount(order.spentCents),
            amount_returned: centsToApiAmount(order.returnedCents),
          },
        };
      default:
        return { status: 200, body: { ...base, status: order.status } };
    }
  }

  /** What bapi stores for an order replay: never a reveal link or an ID check link (both are single use or short lived). */
  function replayBody(body: Record<string, unknown>): Record<string, unknown> {
    const { reveal_url: _reveal, reveal_expires_at: _revealExpires, kyc_url: _kyc, ...kept } = body;
    return body.status === 'identity_check_required'
      ? { ...kept, message: 'This order was already placed. Look up the order for the identity check link.' }
      : kept;
  }

  // Webhooks: what each order and person was last announced as, and what is still to be sent.
  const announced = new Map<string, string>();
  const outbox: Array<{ id: string; body: Buffer; tries: number }> = [];
  let sending = false;

  function enqueue(type: string, data: Record<string, unknown>): void {
    const eventId = `evt_${randomBytes(16).toString('base64url')}`;
    const body = Buffer.from(JSON.stringify({ id: eventId, type, created_at: new Date().toISOString(), data }), 'utf8');
    outbox.push({ id: eventId, body, tries: 0 });
    void drain();
  }

  async function deliver(event: { id: string; body: Buffer }): Promise<boolean> {
    const hook = options.webhook as NonNullable<MockOptions['webhook']>;
    const url = new URL(hook.url);
    try {
      const answer = await (hook.fetchImpl ?? fetch)(hook.url, {
        method: 'POST',
        headers: webhookHeaders(hook.secret, 'wh1', url.pathname, event.body, event.id),
        body: event.body,
        signal: AbortSignal.timeout(MOCK_WEBHOOK_TIMEOUT_MS),
      });
      return answer.ok;
    } catch {
      return false;
    }
  }

  /** One event at a time, in the order they happened; a refused one is tried again before the next. */
  async function drain(): Promise<void> {
    if (sending) return;
    sending = true;
    try {
      for (let next = outbox[0]; next; next = outbox[0]) {
        if (await deliver(next)) {
          outbox.shift();
          continue;
        }
        const wait = MOCK_WEBHOOK_RETRY_MS[next.tries];
        if (wait === undefined) {
          console.warn('[mock] webhook not accepted after every try; dropped', next.id);
          outbox.shift();
          continue;
        }
        next.tries++;
        await new Promise((done) => setTimeout(done, wait).unref());
      }
    } finally {
      sending = false;
    }
  }

  /** Moves orders on with time and announces every status that changed since it was last announced. */
  function sweep(): void {
    for (const order of orders.values()) {
      refresh(order);
      const view = present(order, false).body;
      const status = String(view.status);
      const key = `order:${order.orderId}`;
      if (announced.get(key) === status) continue;
      announced.set(key, status);
      // Like Perflo, "issuing" is not announced: the next change (ready, or failed) is.
      if (status !== 'issuing') enqueue(`order.${status}`, view);
    }
    for (const user of users.values()) {
      const connected = user.grant !== null && user.token !== null;
      const key = `user:${user.userId}`;
      const before = announced.get(key);
      const now = connected ? 'connected' : 'disconnected';
      if (before === now) continue;
      announced.set(key, now);
      // A person who was never connected is not announced as disconnected.
      if (before === undefined && !connected) continue;
      enqueue(`user.${now}`, { user_id: user.userId, external_user_id: user.externalUserId, status: now });
    }
  }

  if (options.webhook) setInterval(sweep, MOCK_SWEEP_MS).unref();

  const app = express();
  app.disable('x-powered-by');
  // Every answer may have changed a status: announce it as soon as the request is done.
  if (options.webhook) {
    app.use((_req, res, next) => {
      res.on('finish', () => setImmediate(sweep));
      next();
    });
  }
  app.use(
    express.json({
      limit: '32kb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));

  // CORS is not needed: the partner calls server to server, and frames call their own origin.

  const signed = (req: Request, _res: Response, next: NextFunction) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const result = verifySignature(req.headers, req.method, req.originalUrl, rawBody, (partnerId) =>
      partnerId === options.partnerId ? { [options.keyVersion]: options.secret } : null,
    );
    if (!result.ok) {
      next(new HttpError(401, 'unauthorized', 'We could not confirm who sent this request.'));
      return;
    }
    next();
  };

  const bearerUser = (req: Request): { user: MUser; token: string } | { revoked: MUser } => {
    const header = req.get('authorization') ?? '';
    const token = /^Bearer ([A-Za-z0-9_-]{8,200})$/.exec(header)?.[1];
    if (token === undefined)
      throw new HttpError(401, 'user_token_invalid', 'This person needs to connect again before you can act for them.');
    const live = tokens.get(token);
    if (live) return { user: users.get(live) as MUser, token };
    const revoked = revokedTokens.get(token);
    if (revoked) return { revoked: users.get(revoked) as MUser };
    throw new HttpError(401, 'user_token_invalid', 'This person needs to connect again before you can act for them.');
  };

  const userFromToken = (req: Request, userId: string): MUser => {
    const who = bearerUser(req);
    if ('revoked' in who || who.user.userId !== userId) {
      throw new HttpError(401, 'user_token_invalid', 'This person needs to connect again before you can act for them.');
    }
    return who.user;
  };

  const v2 = express.Router();
  v2.use(signed);

  const usersBody = z.object({
    external_user_id: z.string().min(1).max(200),
    email: z.string().email().max(320).optional(),
    first_name: z.string().max(100).optional(),
    last_name: z.string().max(100).optional(),
    reissue: z.boolean().optional(),
  });

  v2.post('/users', (req, res) => {
    const body = usersBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'invalid_request', 'Some details are missing or not valid.');
    const { external_user_id, email, first_name, last_name, reissue } = body.data;
    // bapi's idempotency layer: a repeated key answers the stored response, which never carries a token.
    const key = req.get('idempotency-key');
    const scope = key ? `ptn:${options.partnerId}:users:${key}` : null;
    const stored = scope ? userReplays.get(scope) : undefined;
    if (stored) return res.status(stored.status).json(stored.body);
    const send = (status: number, payload: Record<string, unknown>) => {
      if (scope) {
        const { user_access_token: _token, ...kept } = payload;
        userReplays.set(scope, { status, body: kept });
      }
      res.status(status).json(payload);
    };
    // A grant is matched by external_user_id only. A new external id with a known email must
    // sign in with the emailed code, so an email alone never grants access.
    let user = [...users.values()].find((u) => u.externalUserId === external_user_id);
    if (user && user.grant && user.token) {
      if (reissue) {
        const token = mintToken(user);
        send(200, { status: 'approved', user_id: user.userId, user_access_token: token });
        return;
      }
      send(200, { status: 'approved', user_id: user.userId });
      return;
    }
    if (!user) {
      user = {
        userId: id('usr_'),
        externalUserId: external_user_id,
        email: email ?? null,
        firstName: first_name ?? null,
        lastName: last_name ?? null,
        grant: null,
        token: null,
        balanceCents: 0,
        kycApproved: false,
        kycRef: randomBytes(24).toString('base64url'),
      };
      users.set(user.userId, user);
    }
    const login = newLogin(user, null);
    send(202, {
      status: 'login_required',
      login_id: login.loginId,
      login_url: frameUrl('setup', login.frameId),
      expires_at: new Date(login.expiresAt).toISOString(),
    });
  });

  v2.get('/logins/:loginId', (req, res) => {
    const login = logins.get(req.params.loginId);
    if (!login) throw new HttpError(404, 'not_found', 'That sign-in was not found.');
    if (login.status === 'pending') {
      return res.json({ status: login.expiresAt > Date.now() ? 'pending' : 'expired' });
    }
    const user = users.get(login.userId) as MUser;
    if (!login.tokenDelivered && user.token) {
      login.tokenDelivered = true;
      return res.json({ status: 'approved', user_id: user.userId, user_access_token: user.token });
    }
    res.json({ status: 'approved', user_id: user.userId });
  });

  v2.get('/users/:userId', (req, res) => {
    const user = userFromToken(req, req.params.userId);
    const grant = user.grant as Grant;
    const spent = monthSpent(user.userId);
    const waitingOnId = [...orders.values()].some((o) => o.userId === user.userId && o.status === 'identity_check_required');
    const open = [...orders.values()].filter((o) => {
      refresh(o);
      return o.userId === user.userId && o.status === 'ready';
    });
    res.json({
      user_id: user.userId,
      balance: { amount: centsToApiAmount(user.balanceCents), currency: 'USD' },
      limits: {
        per_order: { amount: centsToApiAmount(grant.perOrderCents), currency: 'USD' },
        per_month: { amount: centsToApiAmount(grant.perMonthCents), currency: 'USD' },
        spent_this_month: { amount: centsToApiAmount(spent), currency: 'USD' },
        remaining_this_month: { amount: centsToApiAmount(Math.max(0, grant.perMonthCents - spent)), currency: 'USD' },
      },
      identity_check: {
        required_above: centsToApiAmount(NO_KYC_LIMIT_CENTS),
        status: user.kycApproved ? 'approved' : waitingOnId ? 'required' : 'not_required',
      },
      open_cards: open.map((o) => ({
        order_id: o.orderId,
        last4: (o.card as MCard).last4,
        card_limit: centsToApiAmount(o.amountCents),
        expires_at: new Date((o.card as MCard).expiresAt).toISOString(),
      })),
    });
  });

  v2.post('/users/:userId/top-ups', (req, res) => {
    const user = userFromToken(req, req.params.userId);
    const body = z.object({ amount: amountString.optional() }).safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'invalid_request', 'The amount is not valid.');
    const cents = body.data.amount === undefined ? null : apiAmountToCents(body.data.amount);
    if (cents !== null && (cents <= 0 || cents > MAX_TOP_UP_CENTS)) {
      throw new HttpError(400, 'invalid_request', 'The amount is not valid.');
    }
    const frame = newFrame('top-up', user.userId, { amountCents: cents });
    const topUpId = id('tu_');
    frame.topUpId = topUpId;
    res.status(201).json({
      top_up_id: topUpId,
      frame_url: frameUrl('top-up', frame.id),
      amount: cents === null ? null : centsToApiAmount(cents),
      expires_at: new Date(frame.expiresAt).toISOString(),
    });
  });

  v2.post('/users/:userId/limits-link', (req, res) => {
    const user = userFromToken(req, req.params.userId);
    const frame = newFrame('limits', user.userId);
    res.status(201).json({ frame_url: frameUrl('limits', frame.id), expires_at: new Date(frame.expiresAt).toISOString() });
  });

  const orderBody = z.object({
    user_id: z.string().min(1),
    merchant: z.object({ name: z.string().min(1).max(200), domain: z.string().min(1).max(253) }),
    amount: z.string(),
    currency: z.string(),
    description: z.string().max(500).optional(),
    external_order_id: z.string().max(200).optional(),
  });
  const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;

  v2.post('/orders', (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || key.length > 200) throw new HttpError(400, 'idempotency_key_required', 'Idempotency-Key is required.');
    const who = bearerUser(req);
    const body = orderBody.safeParse(req.body);
    if (!body.success || !DOMAIN.test(body.data.merchant.domain)) {
      throw new HttpError(400, 'invalid_request', 'Some order details are missing or not valid.');
    }
    const owner = 'revoked' in who ? who.revoked : who.user;
    if (owner.userId !== body.data.user_id)
      throw new HttpError(401, 'user_token_invalid', 'This person needs to connect again before you can act for them.');

    const scope = `ptn:${options.partnerId}:${key}`;
    const bodyHash = createHash('sha256')
      .update((req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0))
      .digest('hex');
    const stored = idempotency.get(scope);
    if (stored) {
      if (stored.bodyHash !== bodyHash) {
        throw new HttpError(409, 'idempotency_key_reused', 'This key was already used for a different request. Use a new key.');
      }
      return res.status(stored.status).json(stored.body);
    }

    const valid = isApiAmount(body.data.amount) && apiAmountToCents(body.data.amount) > 0 && body.data.currency === 'USD';
    const tooLarge = valid && apiAmountToCents(body.data.amount) > MAX_CARD_CENTS;
    const order: MOrder = {
      orderId: id('ord_'),
      userId: owner.userId,
      merchant: body.data.merchant,
      amountCents: valid ? apiAmountToCents(body.data.amount) : 0,
      status: 'declined',
      createdAt: Date.now(),
      card: null,
      loadCents: 0,
      usedCents: 0,
      readyAt: null,
      loginId: null,
      frameId: null,
      declined: null,
      spentCents: 0,
      returnedCents: 0,
    };
    orders.set(order.orderId, order);
    if (!valid) {
      order.declined = { reason: 'amount_invalid', message: 'The amount must be in US dollars with two decimal places.' };
    } else if (tooLarge) {
      order.declined = { reason: 'amount_invalid', message: 'Cards can be up to $2,500 each.' };
    } else {
      evaluate(order);
    }
    const out = present(order, true);
    idempotency.set(scope, { bodyHash, status: out.status, body: replayBody(out.body) });
    res.status(out.status).json(out.body);
  });

  v2.get('/orders/:orderId', (req, res) => {
    const order = orders.get(req.params.orderId);
    if (!order) throw new HttpError(404, 'not_found', 'That order was not found.');
    refresh(order);
    res.status(200).json(present(order, false).body);
  });

  v2.post('/orders/:orderId/card-reveal', (req, res) => {
    const order = orders.get(req.params.orderId);
    if (!order) throw new HttpError(404, 'not_found', 'That order was not found.');
    userFromToken(req, order.userId);
    // Reveal links are never stored, so a repeated key answers 201 with only a message.
    const key = req.get('idempotency-key');
    const scope = key ? `ptn:${options.partnerId}:card-reveal:${order.orderId}:${key}` : null;
    if (scope && revealKeys.has(scope)) {
      return res.status(201).json({ message: 'A card link was already handed out for this request. Ask again with a new key.' });
    }
    refresh(order);
    if (order.status !== 'ready') throw new HttpError(409, 'card_not_open', 'This card is no longer open.');
    if (scope) revealKeys.add(scope);
    res.status(201).json(revealLink(order));
  });

  v2.post('/orders/:orderId/cancel', (req, res) => {
    const order = orders.get(req.params.orderId);
    if (!order) throw new HttpError(404, 'not_found', 'That order was not found.');
    const user = userFromToken(req, order.userId);
    refresh(order);
    let returned = 0;
    if (order.status === 'ready' || order.status === 'issuing') {
      returned = order.loadCents;
      // A one-time card closes with its order; a reused card stays open for the person's other orders.
      const card = order.card as MCard;
      if (!card.reusable) card.closed = true;
    } else if (!['awaiting_login', 'awaiting_payment', 'identity_check_required'].includes(order.status)) {
      throw new HttpError(409, 'order_not_cancellable', 'This order can no longer be cancelled.');
    }
    user.balanceCents += returned;
    order.status = 'cancelled';
    order.returnedCents = returned;
    res.status(200).json({ status: 'cancelled', amount_returned: centsToApiAmount(returned) });
  });

  // Frames: pages and their same-origin JSON actions (SPEC 8 and 8a). Not signed: the session id is the capability,
  // sent by the frame page in the X-Perflo-Frame-Session header to /partner/v2/frames/session/<action> (as bapi does).
  const liveFrame = (req: Request): MFrame => {
    const sessionId = req.get('x-perflo-frame-session') ?? '';
    const frame = /^fs_[A-Za-z0-9_-]{43}$/.test(sessionId) ? frames.get(sessionId) : undefined;
    if (!frame) throw new HttpError(404, 'not_found', 'This link is not valid.');
    if (frame.expiresAt < Date.now()) throw new HttpError(410, 'frame_expired', 'This link has expired. Go back and ask for a new one.');
    return frame;
  };

  /** Ids the server-rendered page carries for its postMessage events (never tokens). */
  const frameIds = (sessionId: string) => {
    const frame = frames.get(sessionId);
    return { loginId: frame?.loginId ?? null, topUpId: frame?.topUpId ?? null, orderId: frame?.orderId ?? null };
  };

  const maskEmail = (email: string | null) => (email ? `${email[0]}***${email.slice(email.indexOf('@'))}` : undefined);

  const framesRouter = express.Router();
  framesRouter.get('/:purpose', (req, res) => {
    const purpose = req.params.purpose;
    if (purpose !== 'setup' && purpose !== 'top-up' && purpose !== 'limits') {
      return res.status(404).type('text/plain').send('Not found');
    }
    res
      .set('Content-Security-Policy', `default-src 'self'; frame-ancestors ${options.partnerOrigin}; base-uri 'none'; form-action 'self'`)
      .set('Cache-Control', 'no-store')
      .set('Referrer-Policy', 'no-referrer')
      .type('html')
      .send(framePage(options.partnerOrigin, frameIds(typeof req.query.session === 'string' ? req.query.session : '')));
  });

  framesRouter.get('/session/state', (req, res) => {
    const frame = liveFrame(req);
    const user = users.get(frame.userId) as MUser;
    const order = frame.orderId ? orders.get(frame.orderId) : undefined;
    res.json({
      purpose: frame.purpose,
      step: frame.step,
      partner: { brand: { name: MOCK_BRAND } },
      ...(user.email ? { email_masked: maskEmail(user.email) } : {}),
      ...(frame.amountCents !== null ? { amount: centsToApiAmount(frame.amountCents) } : {}),
      ...(order ? { order: { merchant: order.merchant, amount: centsToApiAmount(order.amountCents) } } : {}),
    });
  });

  const shortfall = (frame: MFrame): number => {
    if (!frame.orderId) return 0;
    const order = orders.get(frame.orderId) as MOrder;
    const user = users.get(frame.userId) as MUser;
    if (!user.grant || order.amountCents > user.grant.perOrderCents) return 0;
    return Math.max(0, quote(order.amountCents).totalCents - user.balanceCents);
  };

  framesRouter.post('/session/login', (req, res) => {
    const frame = liveFrame(req);
    if (frame.purpose !== 'setup' || frame.step !== 'login') throw new HttpError(409, 'frame_step_invalid', 'This step is already done.');
    const body = z.object({ privy_access_token: z.string().max(400) }).safeParse(req.body);
    // Mock sign-in token: "mock-otp:<email>:<code>". The real frame sends a Privy access token.
    // "mock-otp:<code>" when Perflo already knows the email, "mock-otp:<email>:<code>" when the frame asked for it.
    const match = body.success ? /^mock-otp:(?:([^:\s]+@[^:\s]+):)?([0-9]{6})$/.exec(body.data.privy_access_token) : null;
    const user = users.get(frame.userId) as MUser;
    const email = user.email ?? match?.[1] ?? null;
    if (!match || match[2] !== MOCK_CODE || !email) {
      throw new HttpError(401, 'sign_in_failed', 'That code is not right. Check it and try again.');
    }
    user.email = email;
    frame.loggedIn = true;
    frame.step = 'limits';
    res.json({ next: 'limits', user: { email_masked: maskEmail(user.email) } });
  });

  const limitsBody = z.object({ per_order: amountString, per_month: amountString });

  framesRouter.post('/session/limits', (req, res) => {
    const frame = liveFrame(req);
    if (frame.step !== 'limits') throw new HttpError(409, 'frame_step_invalid', 'This step is already done.');
    const body = limitsBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'limits_invalid', 'Choose an amount per order and per month.');
    const perOrder = apiAmountToCents(body.data.per_order);
    const perMonth = apiAmountToCents(body.data.per_month);
    if (perOrder <= 0 || perMonth <= 0 || perOrder > MAX_TOP_UP_CENTS * 10 || perMonth > MAX_TOP_UP_CENTS * 10) {
      throw new HttpError(400, 'limits_invalid', 'Choose amounts above zero.');
    }
    if (perOrder > perMonth) {
      throw new HttpError(400, 'limits_invalid', 'The amount per order cannot be more than the amount per month.');
    }
    const user = users.get(frame.userId) as MUser;
    user.grant = { perOrderCents: perOrder, perMonthCents: perMonth };
    if (frame.purpose === 'setup') {
      mintToken(user);
      const login = logins.get(frame.loginId as string) as MLogin;
      login.status = 'approved';
      const due = shortfall(frame);
      frame.step = due > 0 ? 'top_up' : 'done';
      if (due > 0) frame.amountCents = due;
    } else {
      frame.step = 'done';
    }
    res.json({ next: frame.step, limits: body.data });
  });

  framesRouter.post('/session/top-up', (req, res) => {
    const frame = liveFrame(req);
    if (frame.step !== 'top_up') throw new HttpError(409, 'frame_step_invalid', 'This step is already done.');
    const body = z.object({ amount: amountString }).safeParse(req.body);
    const cents = body.success ? apiAmountToCents(body.data.amount) : 0;
    if (cents <= 0 || cents > MAX_TOP_UP_CENTS) throw new HttpError(400, 'amount_invalid', 'Enter an amount between $0.01 and $10,000.00.');
    if (frame.amountCents !== null && frame.orderId && cents < frame.amountCents) {
      throw new HttpError(400, 'amount_too_low', `This order needs at least ${centsToApiAmount(frame.amountCents)}.`);
    }
    const topUp: MTopUp = {
      topUpId: frame.topUpId ?? id('tu_'),
      frameId: frame.id,
      userId: frame.userId,
      amountCents: cents,
      clientSecret: `mock_cs_${randomBytes(24).toString('base64url')}`,
      paid: false,
    };
    frame.topUpId = topUp.topUpId;
    topUps.set(topUp.topUpId, topUp);
    res.status(201).json({
      client_secret: topUp.clientSecret,
      top_up_id: topUp.topUpId,
      amount: centsToApiAmount(cents),
      publishable_key: 'pk_test_mock',
    });
  });

  framesRouter.post('/session/complete', (req, res) => {
    const frame = liveFrame(req);
    const body = z.object({ step: z.enum(['top_up', 'setup']) }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'invalid_request', 'Unknown step.');
    if (body.data.step === 'top_up') {
      const topUp = frame.topUpId ? topUps.get(frame.topUpId) : undefined;
      if (!topUp || !topUp.paid) throw new HttpError(409, 'payment_not_received', 'We have not received this payment yet.');
      frame.step = 'done';
    } else {
      const user = users.get(frame.userId) as MUser;
      if (frame.purpose !== 'setup' || !user.grant || !user.token) {
        throw new HttpError(409, 'frame_step_invalid', 'Setup is not finished yet.');
      }
      frame.step = 'done';
    }
    let orderStatus: string | undefined;
    if (frame.orderId) {
      const order = orders.get(frame.orderId) as MOrder;
      refresh(order);
      orderStatus = present(order, false).body.status as string;
    }
    res.json({ next: 'done', ...(orderStatus ? { order_status: orderStatus } : {}) });
  });

  framesRouter.post('/session/revoke', (req, res) => {
    const frame = liveFrame(req);
    revokeAccess(users.get(frame.userId) as MUser);
    res.json({ revoked: true });
  });

  function revokeAccess(user: MUser): void {
    if (user.token) {
      tokens.delete(user.token);
      revokedTokens.set(user.token, user.userId);
    }
    user.token = null;
    user.grant = null;
  }

  // Frames are not signed, so mount them before the signature check.
  app.use('/partner/v2/frames', framesRouter);
  app.use('/partner/v2', v2);

  app.get('/mock-assets/:file', (req, res) => {
    const asset = frameAssets[req.params.file];
    if (!asset) return res.status(404).end();
    res.type(asset.type).set('Cache-Control', 'no-store').send(asset.body);
  });

  app.post('/mock-stripe/pay', (req, res) => {
    const body = z.object({ client_secret: z.string() }).safeParse(req.body);
    const topUp = body.success ? [...topUps.values()].find((t) => t.clientSecret === body.data.client_secret) : undefined;
    if (!topUp) throw new HttpError(404, 'not_found', 'Payment not found.');
    if (!topUp.paid) {
      topUp.paid = true;
      (users.get(topUp.userId) as MUser).balanceCents += topUp.amountCents;
    }
    res.json({ status: 'succeeded' });
  });

  /**
   * The reveal link, as bapi #345 and ms-card #94 check it: the partner signature over GET and the
   * link's path (no query), and the Bearer token of the person whose card it is. Every refusal is the
   * same 404 and leaves the link usable; only a successful read uses it up.
   */
  app.get('/mock-relay/partner-cards/:cardId/sensitive', (req, res) => {
    const refuse = () => res.status(404).json({ success: false, error: 'This link has expired or was already used.' });
    const t = typeof req.query.t === 'string' ? req.query.t : '';
    const entry = reveals.get(t);
    const order = entry ? orders.get(entry.orderId) : undefined;
    if (!entry || entry.consumed || entry.expiresAt < Date.now() || !order || order.card?.cardId !== req.params.cardId) return refuse();
    const signature = verifySignature(req.headers, 'GET', req.originalUrl, Buffer.alloc(0), (partnerId) =>
      partnerId === options.partnerId ? { [options.keyVersion]: options.secret } : null,
    );
    const bearer = /^Bearer ([A-Za-z0-9_-]{8,200})$/.exec(req.get('authorization') ?? '')?.[1];
    if (!signature.ok || bearer === undefined || tokens.get(bearer) !== order.userId) return refuse();
    refresh(order);
    if (order.status !== 'ready') return refuse();
    entry.consumed = true;
    const card = order.card;
    const user = users.get(order.userId) as MUser;
    res.set('Cache-Control', 'no-store').json({
      success: true,
      data: {
        card_number: card.number,
        cvv: card.cvv,
        exp_month: card.expMonth,
        exp_year: card.expYear,
        holder_name: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Card holder',
        brand: 'Visa',
        last4: card.last4,
        billing_address: null,
        card_status: 'active',
      },
    });
  });

  app.post('/mock-merchant/checkout', (req, res) => {
    const body = z
      .object({ card_number: z.string(), cvv: z.string(), exp_month: z.string(), exp_year: z.string(), amount: amountString })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ approved: false, reason: 'form_incomplete' });
    // A reused card serves several orders: a charge pays the oldest one still open (orders are kept oldest first).
    const onCard = [...orders.values()].filter((o) => o.card?.number === body.data.card_number);
    for (const o of onCard) refresh(o);
    const order = onCard.find((o) => o.status === 'ready');
    if (!order) return res.status(402).json({ approved: false, reason: 'declined' });
    const card = order.card as MCard;
    const charge = apiAmountToCents(body.data.amount);
    if (
      card.cvv !== body.data.cvv ||
      card.expMonth !== body.data.exp_month ||
      card.expYear !== body.data.exp_year ||
      charge > order.amountCents
    ) {
      return res.status(402).json({ approved: false, reason: 'declined' });
    }
    order.status = 'completed';
    order.spentCents = charge;
    order.usedCents = Math.ceil((charge * 1033) / 1000) + 25;
    // First spend closes a one-time card and the leftover goes back to the balance. On a reused card the
    // money stays on the card until it closes at its 12 hours (closeCard).
    if (!card.reusable) {
      card.closed = true;
      order.returnedCents = Math.max(0, order.loadCents - order.usedCents);
      (users.get(order.userId) as MUser).balanceCents += order.returnedCents;
    }
    res.json({ approved: true });
  });

  app.get('/mock/kyc', (req, res) => {
    const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
    const user = [...users.values()].find((u) => u.kycRef === ref);
    res.set('Content-Security-Policy', "default-src 'self'; form-action 'self'").type('html');
    if (!user) return res.status(404).send(kycPage('missing', ''));
    res.send(kycPage(user.kycApproved ? 'done' : 'start', ref));
  });

  app.post('/mock/kyc', (req, res) => {
    const ref = z.object({ ref: z.string().max(100) }).safeParse(req.body).data?.ref ?? '';
    const user = [...users.values()].find((u) => u.kycRef === ref);
    res.set('Content-Security-Policy', "default-src 'self'; form-action 'self'").type('html');
    if (!user) return res.status(404).send(kycPage('missing', ''));
    user.kycApproved = true;
    res.send(kycPage('done', ref));
  });

  app.post('/mock/control/revoke', (req, res) => {
    const body = z.object({ user_id: z.string() }).safeParse(req.body);
    const user = body.success ? users.get(body.data.user_id) : undefined;
    if (!user) return res.status(404).json({ error: { code: 'not_found', message: 'Unknown person.' } });
    revokeAccess(user);
    res.json({ revoked: true });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof SyntaxError) {
      return res.status(400).json({ error: { code: 'invalid_request', message: 'The request could not be read.' } });
    }
    console.error('[mock] unexpected error', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong. Try again.' } });
  });

  return app;
}
