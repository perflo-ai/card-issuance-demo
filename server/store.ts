/**
 * Demo persistence: one JSON file with owner-only permissions, because it holds
 * user access tokens.
 *
 * - In memory every collection is a Map, so a key that comes from a cookie or a
 *   URL (`__proto__`, `constructor`) can only ever find a record Tiny stored.
 * - The file is validated when it is opened. A file that cannot be read or does
 *   not have the expected shape stops the server with a clear message: Tiny
 *   never guesses a missing field (a user with no `perflo` field is not
 *   "linked", a session with no expiry does not last forever). A file that does
 *   not exist yet is the one case that starts empty, and the caller logs it.
 * - A write happens only when something actually changed (a status read that
 *   found the same answer writes nothing), synchronously, to a temporary file
 *   that is flushed to disk and then renamed over the old one. Synchronous on
 *   purpose: a token Perflo hands out exactly once, or an order's
 *   Idempotency-Key, is on disk before the request that depends on it is sent.
 *   Writes are not delayed or batched for the same reason; they happen at the
 *   pace of real changes (a person's actions and status changes), not of polls.
 *
 * ponytail: whole-file rewrite per change and one process only; a partner
 * moves this to their own database.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { orderResponse, type OrderResponse } from './perfloApi.js';
import { LOOK_IDS, type CheckoutSummary, type LookId } from './views.js';

export type { CheckoutSummary } from './views.js';

export interface PerfloLink {
  userId: string;
  /** Server-side only. Never sent to the browser or the log. */
  token: string;
}

/**
 * A Tiny account. It holds no name or email: the person proves their email to
 * Perflo inside Perflo's own sign-in frame, and Tiny never asks for it.
 */
export interface DemoUser {
  id: string;
  createdAt: string;
  perflo: PerfloLink | null;
  /**
   * The login we are waiting on, from POST /users or an order's login_required. `clientSecret` opens the
   * same sign-in with Perflo.js; absent when Perflo did not send one (or stored by an earlier version).
   */
  pendingLogin: { loginId: string; loginUrl: string; clientSecret?: string; orderId: string | null } | null;
  /** Mock mode test control: fill the checkout but do not buy, so the card stays open. */
  testStopAtCheckout?: boolean;
  /** The example look Perflo's pages are opened in from now on (server/looks.ts). Absent: the brand default. */
  look?: LookId;
}

export interface OrderIntent {
  merchantName: string;
  domain: string;
  amountCents: number;
  description: string;
}

export interface DemoOrder {
  id: string;
  demoUserId: string;
  /** Stable for the life of this chat order, so a retry can never place a second order. */
  idempotencyKey: string;
  intent: OrderIntent;
  state: 'draft' | 'discarded' | 'placing' | 'placed';
  perfloOrderId: string | null;
  last: OrderResponse | null;
  revealUsed: boolean;
  checkout: CheckoutSummary | null;
  amountReturned: string | null;
  createdAt: string;
  /**
   * The look the order was made with, fixed when it was made: every POST of this order carries the same
   * Idempotency-Key, so its body must not change when the person picks another look later. Absent: the
   * brand default (also every order stored before looks existed, which were sent without one).
   */
  look?: LookId;
  /**
   * The card Perflo answered when the order was ready, kept after the order moves on: a later
   * answer (completed, cancelled) no longer names the card, and a card can serve several orders.
   * Absent until the order was ready, and on orders stored by earlier versions.
   */
  card?: OrderCard;
}

export interface OrderCard {
  cardId: string;
  last4: string;
  expiresAt: string;
}

/** How long a browser stays signed in to Tiny without coming back. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/**
 * After a rotation the old id keeps working this long, so requests the page
 * already had on their way do not fail. Short, because the point of rotating
 * is that the old id stops being useful.
 */
const ROTATION_GRACE_MS = 30_000;

/**
 * How long a webhook event id is remembered. Perflo tries an event again for up to 24 hours, so a
 * retry that arrives after Tiny already handled it is still recognised.
 */
export const WEBHOOK_EVENT_MEMORY_MS = 48 * 60 * 60_000;

/** Session ids as Tiny makes them: 32 random bytes, base64url. Anything else is not looked up at all. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface SessionRecord {
  userId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

const isoTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const perfloLink = z.object({ userId: z.string().min(1), token: z.string().min(1) }).strict();
const pendingLogin = z
  .object({
    loginId: z.string().min(1),
    loginUrl: z.string().url(),
    clientSecret: z.string().min(1).optional(),
    orderId: z.string().nullable(),
  })
  .strict();
const look = z.enum(LOOK_IDS);
const userRecord = z
  .object({
    id: z.string().min(1),
    createdAt: isoTime,
    perflo: perfloLink.nullable(),
    pendingLogin: pendingLogin.nullable(),
    testStopAtCheckout: z.boolean().optional(),
    look: look.optional(),
    // Kept by versions that asked for a name and email at sign-up; read only to be dropped.
    firstName: z.unknown().optional(),
    lastName: z.unknown().optional(),
    email: z.unknown().optional(),
  })
  .strict();
const checkoutSummary = z
  .object({
    last4: z.string(),
    expMonth: z.string(),
    expYear: z.string(),
    cardLimit: z.string(),
    filledAt: z.string(),
    outcome: z.enum(['charged', 'filled_not_submitted', 'charge_refused']),
  })
  .strict();
const orderRecord = z
  .object({
    id: z.string().min(1),
    demoUserId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    intent: z
      .object({ merchantName: z.string(), domain: z.string(), amountCents: z.number().int().positive(), description: z.string() })
      .strict(),
    state: z.enum(['draft', 'discarded', 'placing', 'placed']),
    perfloOrderId: z.string().nullable(),
    last: orderResponse.nullable(),
    revealUsed: z.boolean(),
    checkout: checkoutSummary.nullable(),
    amountReturned: z.string().nullable(),
    createdAt: isoTime,
    look: look.optional(),
    card: z
      .object({ cardId: z.string().min(1), last4: z.string(), expiresAt: z.string() })
      .strict()
      .optional(),
  })
  .strict();
const sessionRecord = z.union([
  z.object({ userId: z.string().min(1), expiresAt: z.number().int().positive() }).strict(),
  // Versions before sessions expired stored the user id alone.
  z.string().min(1),
]);
const storeFile = z
  .object({
    sessions: z.record(z.string(), sessionRecord),
    users: z.record(z.string(), userRecord),
    orders: z.record(z.string(), orderRecord),
    // Webhook event ids already handled, with when they arrived (epoch ms). Older files have none.
    webhookEvents: z.record(z.string(), z.number().int().positive()).optional(),
  })
  .strict();

/** Reads and checks the data file. Throws StoreError, naming only the file and what is wrong, never its content. */
function readStoreFile(file: string): { raw: string; data: z.infer<typeof storeFile> } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new StoreError(
      `The data file ${file} could not be read (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'}).`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new StoreError(`The data file ${file} is not valid JSON. Move it away to start empty, or restore it from a backup.`);
  }
  const parsed = storeFile.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.') ?? 'the top level';
    throw new StoreError(
      `The data file ${file} does not have the expected shape (first problem at ${where}). Tiny will not guess; fix or move the file.`,
    );
  }
  for (const [key, user] of Object.entries(parsed.data.users)) {
    if (key !== user.id) throw new StoreError(`The data file ${file} lists a user under another id.`);
  }
  for (const [key, order] of Object.entries(parsed.data.orders)) {
    if (key !== order.id) throw new StoreError(`The data file ${file} lists an order under another id.`);
  }
  return { raw, data: parsed.data };
}

export class Store {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly users = new Map<string, DemoUser>();
  private readonly orders = new Map<string, DemoOrder>();
  private readonly webhookEvents = new Map<string, number>();
  /** What the file holds now; a save that would write the same bytes writes nothing. */
  private written: string | null = null;
  /** False when there was no data file: the caller logs that Tiny started empty. */
  readonly loadedFromFile: boolean;

  constructor(private readonly file: string) {
    this.loadedFromFile = existsSync(file);
    if (!this.loadedFromFile) return;
    const { raw, data } = readStoreFile(file);
    const now = Date.now();
    for (const [id, record] of Object.entries(data.orders)) this.orders.set(id, record);
    for (const [id, at] of Object.entries(data.webhookEvents ?? {})) {
      if (at > now - WEBHOOK_EVENT_MEMORY_MS) this.webhookEvents.set(id, at);
    }
    for (const [id, record] of Object.entries(data.users)) {
      // Names and emails typed at the old sign-up are dropped: nothing reads them any more.
      const { firstName: _first, lastName: _last, email: _email, ...user } = record;
      this.users.set(id, user);
    }
    for (const [sid, record] of Object.entries(data.sessions)) {
      // An old session without an expiry gets a fresh one; an expired one, or one for nobody, is dropped.
      const session = typeof record === 'string' ? { userId: record, expiresAt: now + SESSION_TTL_MS } : record;
      if (session.expiresAt > now && this.users.has(session.userId) && SESSION_ID_PATTERN.test(sid)) this.sessions.set(sid, session);
    }
    for (const user of [...this.users.values()]) {
      const newest = user.perflo && this.users.has(user.id) ? this.newestLinked(user.perflo.userId) : undefined;
      if (newest) this.foldSamePerson(newest.id);
    }
    // Written back only if opening it changed something (an old shape migrated, an expired session dropped).
    this.written = raw;
    this.save();
  }

  private newestLinked(perfloUserId: string): DemoUser | undefined {
    return [...this.users.values()]
      .filter((u) => u.perflo?.userId === perfloUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  /**
   * One person, one Tiny account, decided by Perflo: Tiny accounts linked to
   * the same Perflo user have each proved that person's email with Perflo's
   * code. Each new browser starts a new anonymous account, so without this a
   * person who signed in again lost sight of their earlier orders. Moves the
   * others' orders and sessions onto `keepId` and removes them.
   */
  private foldSamePerson(keepId: string): void {
    const keep = this.users.get(keepId);
    if (!keep?.perflo) return;
    const others = [...this.users.values()].filter((u) => u.id !== keepId && u.perflo?.userId === keep.perflo?.userId);
    for (const other of others) {
      for (const order of this.orders.values()) {
        if (order.demoUserId === other.id) order.demoUserId = keepId;
      }
      for (const record of this.sessions.values()) {
        if (record.userId === other.id) record.userId = keepId;
      }
      this.users.delete(other.id);
    }
  }

  /** Stores the Perflo link for a Tiny account, and folds in the person's other Tiny accounts. */
  linkPerflo(id: string, link: PerfloLink): DemoUser {
    const user = this.requireUser(id);
    user.perflo = link;
    user.pendingLogin = null;
    this.foldSamePerson(id);
    this.save();
    return user;
  }

  /** Writes the store if, and only if, its content changed since the last write. */
  private save(): void {
    const json = JSON.stringify(
      {
        sessions: Object.fromEntries(this.sessions),
        users: Object.fromEntries(this.users),
        orders: Object.fromEntries(this.orders),
        webhookEvents: Object.fromEntries(this.webhookEvents),
      },
      null,
      2,
    );
    if (json === this.written) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeSync(fd, json);
      // On disk before the rename makes it the store: a crash leaves the old file or the new one, never half of one.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.file);
    this.written = json;
  }

  /**
   * A new browser gets a new anonymous account with no payments link and no
   * personal details. A returning browser continues through its session
   * cookie. The person connects by proving their email to Perflo with the
   * emailed code; if that Perflo user already has a Tiny account, the two are
   * folded together (see foldSamePerson).
   */
  createUser(): { user: DemoUser; sessionId: string } {
    const user: DemoUser = { id: randomUUID(), createdAt: new Date().toISOString(), perflo: null, pendingLogin: null };
    this.users.set(user.id, user);
    const sessionId = this.newSession(user.id);
    this.save();
    return { user, sessionId };
  }

  private newSession(userId: string): string {
    const sessionId = randomBytes(32).toString('base64url');
    this.sessions.set(sessionId, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
    return sessionId;
  }

  /**
   * The account a session id opens, or null. Only an id of the shape Tiny makes is looked up, and only
   * among sessions Tiny stored; an unknown id changes nothing and writes nothing. An expired session is
   * removed (that is a real change, written once).
   */
  userForSession(sessionId: string | undefined): DemoUser | null {
    if (sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId)) return null;
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      this.save();
      return null;
    }
    return this.users.get(record.userId) ?? null;
  }

  /**
   * A new session id for the same account, used when the account gains access
   * to someone's money (it links to Perflo). An id that existed before that
   * moment, wherever it may have leaked or been planted, no longer opens the
   * linked account once the short grace period ends.
   */
  rotateSession(sessionId: string): string | null {
    if (!SESSION_ID_PATTERN.test(sessionId)) return null;
    const old = this.sessions.get(sessionId);
    if (!old) return null;
    const fresh = this.newSession(old.userId);
    old.expiresAt = Math.min(old.expiresAt, Date.now() + ROTATION_GRACE_MS);
    this.save();
    return fresh;
  }

  endSession(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.save();
  }

  private requireUser(id: string): DemoUser {
    const user = this.users.get(id);
    if (!user) throw new Error('unknown demo user');
    return user;
  }

  user(id: string): DemoUser {
    return this.requireUser(id);
  }

  updateUser(id: string, change: (user: DemoUser) => void): DemoUser {
    const user = this.requireUser(id);
    change(user);
    this.save();
    return user;
  }

  createOrder(demoUserId: string, intent: OrderIntent): DemoOrder {
    const look = this.users.get(demoUserId)?.look;
    const order: DemoOrder = {
      id: randomUUID(),
      demoUserId,
      idempotencyKey: randomUUID(),
      intent,
      state: 'draft',
      perfloOrderId: null,
      last: null,
      revealUsed: false,
      checkout: null,
      amountReturned: null,
      createdAt: new Date().toISOString(),
      ...(look ? { look } : {}),
    };
    this.orders.set(order.id, order);
    this.save();
    return order;
  }

  order(demoUserId: string, id: string): DemoOrder | null {
    const order = this.orders.get(id);
    return order && order.demoUserId === demoUserId ? order : null;
  }

  orderByPerfloId(demoUserId: string, perfloOrderId: string): DemoOrder | null {
    return [...this.orders.values()].find((o) => o.demoUserId === demoUserId && o.perfloOrderId === perfloOrderId) ?? null;
  }

  /**
   * The order Perflo knows by this id, whoever it belongs to. Only for a signed webhook, which names
   * an order and no person; every route a browser reaches looks orders up within its own account.
   */
  orderForWebhook(perfloOrderId: string): DemoOrder | null {
    return [...this.orders.values()].find((o) => o.perfloOrderId === perfloOrderId) ?? null;
  }

  /** The Tiny account with this id, or null. Tiny's account id is the external_user_id Perflo knows. */
  findUser(id: string): DemoUser | null {
    return this.users.get(id) ?? null;
  }

  /**
   * Records a webhook event id. True the first time it is seen, false for a retry of one already
   * handled. Ids older than WEBHOOK_EVENT_MEMORY_MS are forgotten as new ones arrive.
   */
  rememberWebhookEvent(eventId: string, now: number = Date.now()): boolean {
    for (const [id, at] of this.webhookEvents) {
      if (at <= now - WEBHOOK_EVENT_MEMORY_MS) this.webhookEvents.delete(id);
    }
    if (this.webhookEvents.has(eventId)) return false;
    this.webhookEvents.set(eventId, now);
    this.save();
    return true;
  }

  ordersFor(demoUserId: string): DemoOrder[] {
    return [...this.orders.values()]
      .filter((o) => o.demoUserId === demoUserId && o.state !== 'discarded')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Applies a change to an order this store handed out; written only if it changed anything. */
  updateOrder(order: DemoOrder, change: (order: DemoOrder) => void): DemoOrder {
    if (this.orders.get(order.id) !== order) throw new Error('unknown demo order');
    change(order);
    this.save();
    return order;
  }
}
