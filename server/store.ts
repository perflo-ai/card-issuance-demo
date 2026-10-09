/**
 * Demo persistence: one JSON file, written atomically (temp file + rename) with
 * owner-only permissions because it holds user access tokens. Synchronous on
 * purpose: every mutation is written before the caller continues, so a token
 * Perflo hands out exactly once is on disk before anything else happens.
 *
 * ponytail: whole-file rewrite per change, fine for a demo; a real partner
 * stores this in its own database.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrderResponse } from './perfloApi.js';
import type { CheckoutSummary } from './views.js';

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
  /** The login we are waiting on, from POST /users or an order's login_required. */
  pendingLogin: { loginId: string; loginUrl: string; orderId: string | null } | null;
  /** Mock mode test control: fill the checkout but do not buy, so the card stays open. */
  testStopAtCheckout?: boolean;
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
}

interface StoreShape {
  sessions: Record<string, string>;
  users: Record<string, DemoUser>;
  orders: Record<string, DemoOrder>;
}

export class Store {
  private data: StoreShape;

  constructor(private readonly file: string) {
    this.data = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as StoreShape)
      : { sessions: {}, users: {}, orders: {} };
    let changed = false;
    for (const user of Object.values(this.data.users)) {
      // Files from earlier versions kept the name and email typed at sign-up. Nothing reads them any
      // more, so they are dropped rather than kept as personal data with no use.
      const legacy = user as DemoUser & { firstName?: unknown; lastName?: unknown; email?: unknown };
      if ('firstName' in legacy || 'lastName' in legacy || 'email' in legacy) {
        delete legacy.firstName;
        delete legacy.lastName;
        delete legacy.email;
        changed = true;
      }
    }
    for (const user of Object.values(this.data.users)) {
      if (user.perflo && this.data.users[user.id] && this.foldSamePerson(this.newestLinked(user.perflo.userId).id)) changed = true;
    }
    if (changed) this.save();
  }

  private newestLinked(perfloUserId: string): DemoUser {
    return Object.values(this.data.users)
      .filter((u) => u.perflo?.userId === perfloUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  /**
   * One person, one Tiny account, decided by Perflo: Tiny accounts linked to
   * the same Perflo user have each proved that person's email with Perflo's
   * code. Each new browser starts a new anonymous account, so without this a
   * person who signed in again lost sight of their earlier orders. Moves the others' orders and sessions onto `keepId` and
   * removes them. Returns whether anything moved.
   */
  private foldSamePerson(keepId: string): boolean {
    const keep = this.data.users[keepId];
    if (!keep?.perflo) return false;
    const others = Object.values(this.data.users).filter((u) => u.id !== keepId && u.perflo?.userId === keep.perflo?.userId);
    for (const other of others) {
      for (const order of Object.values(this.data.orders)) {
        if (order.demoUserId === other.id) order.demoUserId = keepId;
      }
      for (const [sid, uid] of Object.entries(this.data.sessions)) {
        if (uid === other.id) this.data.sessions[sid] = keepId;
      }
      delete this.data.users[other.id];
    }
    return others.length > 0;
  }

  /** Stores the Perflo link for a Tiny account, and folds in the person's other Tiny accounts. */
  linkPerflo(id: string, link: PerfloLink): DemoUser {
    const user = this.data.users[id];
    if (!user) throw new Error('unknown demo user');
    user.perflo = link;
    user.pendingLogin = null;
    this.foldSamePerson(id);
    this.save();
    return user;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  /**
   * A new browser gets a new anonymous account with no payments link and no
   * personal details. A returning browser continues through its session
   * cookie. The person connects by proving their email to Perflo with the
   * emailed code; if that Perflo user already has a Tiny account, the two are
   * folded together (see foldSamePerson).
   */
  createUser(): { user: DemoUser; sessionId: string } {
    const user: DemoUser = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      perflo: null,
      pendingLogin: null,
    };
    this.data.users[user.id] = user;
    const sessionId = randomBytes(32).toString('base64url');
    this.data.sessions[sessionId] = user.id;
    this.save();
    return { user, sessionId };
  }

  userForSession(sessionId: string | undefined): DemoUser | null {
    if (!sessionId || !Object.hasOwn(this.data.sessions, sessionId)) return null;
    return this.data.users[this.data.sessions[sessionId]] ?? null;
  }

  endSession(sessionId: string): void {
    delete this.data.sessions[sessionId];
    this.save();
  }

  user(id: string): DemoUser {
    const user = this.data.users[id];
    if (!user) throw new Error('unknown demo user');
    return user;
  }

  updateUser(id: string, change: (user: DemoUser) => void): DemoUser {
    const user = this.data.users[id];
    if (!user) throw new Error('unknown demo user');
    change(user);
    this.save();
    return user;
  }

  createOrder(demoUserId: string, intent: OrderIntent): DemoOrder {
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
    };
    this.data.orders[order.id] = order;
    this.save();
    return order;
  }

  order(demoUserId: string, id: string): DemoOrder | null {
    const order = Object.hasOwn(this.data.orders, id) ? this.data.orders[id] : undefined;
    return order && order.demoUserId === demoUserId ? order : null;
  }

  orderByPerfloId(demoUserId: string, perfloOrderId: string): DemoOrder | null {
    return (
      Object.values(this.data.orders).find((o) => o.demoUserId === demoUserId && o.perfloOrderId === perfloOrderId) ??
      null
    );
  }

  ordersFor(demoUserId: string): DemoOrder[] {
    return Object.values(this.data.orders)
      .filter((o) => o.demoUserId === demoUserId && o.state !== 'discarded')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  updateOrder(order: DemoOrder, change: (order: DemoOrder) => void): DemoOrder {
    change(order);
    this.save();
    return order;
  }
}
