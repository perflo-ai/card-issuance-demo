/**
 * The partner-side flow: everything Tiny's backend does against Perflo.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DemoConfig } from './config.js';
import type { EventLog } from './eventLog.js';
import { DEFAULT_LOOK, lookFields, type LookId } from './looks.js';
import { centsToApiAmount } from './money.js';
import { LiveUpdates } from './live.js';
import { nextStep, recordAnswer, TERMINAL_STATUSES, toView } from './orderState.js';
import {
  isUserTokenRefused,
  PerfloApiError,
  PerfloUnavailableError,
  type AccountResponse,
  type LinkCardResponse,
  type LinkedCard,
  type OrderResponse,
  type PerfloApi,
} from './perfloApi.js';
import { revealCard, RevealError, simulateCheckout, type RevealedCard } from './checkout.js';
import type { DemoOrder, DemoUser, Store } from './store.js';
import { cardClosedData, type WebhookEvent } from './webhooks.js';

import type {
  AutoTopUpChoice,
  AutoTopUpView,
  ConnectView,
  LinkCardView,
  LinkedCardView,
  LinkStatus,
  Notice,
  PerfloPageView,
} from './views.js';

export type { LinkStatus, Notice } from './views.js';

export class DemoError extends Error {
  constructor(
    readonly code: 'not_linked' | 'not_found' | 'conflict' | 'bad_request',
    message: string,
    /** For the server log only, when the operator has something to fix. */
    readonly operatorNote?: string,
  ) {
    super(message);
    this.name = 'DemoError';
  }
}

/** Waits before trying a webhook's follow-up read again, when Perflo was briefly unavailable. */
const WEBHOOK_RETRY_DELAYS_MS = [2_000, 10_000];

export class DemoService {
  private readonly locks = new Map<string, Promise<unknown>>();
  /**
   * Orders being placed right now. POST /checkout/orders can take a while, and Perflo may announce a change
   * to the order before its answer (with the order id) is stored here; such a webhook waits for these.
   */
  private readonly placing = new Set<Promise<unknown>>();
  /**
   * How many Idempotency-Keys a card token's Save has used up, kept only while a Save of it failed on
   * Perflo's side (see linkCard). ponytail: in memory; a restart starts at the first key again, which
   * at worst replays that one failure once.
   */
  private readonly linkKeyGenerations = new Map<string, number>();
  /** The person's open pages, which hear about changes as they happen. */
  /** Each stream is checked against the store before every write: only a session that still opens this account hears it. */
  readonly live = new LiveUpdates((sessionId, demoUserId) => this.store.userForSession(sessionId)?.id === demoUserId);

  constructor(
    private readonly store: Store,
    private readonly api: PerfloApi,
    private readonly log: EventLog,
    private readonly config: DemoConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** One flow per key at a time, so a double click cannot reveal or place twice. */
  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  private storeToken(user: DemoUser, userId: string, token: string): DemoUser {
    // Written to disk before anything else: Perflo hands a token out once.
    return this.store.linkPerflo(user.id, { userId, token });
  }

  /**
   * A new token for a person Perflo already approved. Replays of POST /users never carry a token,
   * so each attempt uses a new Idempotency-Key, and a tokenless answer is retried once.
   */
  private async reissue(user: DemoUser): Promise<DemoUser> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const again = await this.api.createUser(user.id, { ...this.userBody(user), reissue: true }, randomUUID());
      if (again.status === 'approved' && again.user_access_token) {
        return this.storeToken(user, again.user_id, again.user_access_token);
      }
      if (again.status === 'connection_required') {
        throw new DemoError('conflict', 'Payments need to be set up again. Send your request once more.');
      }
    }
    throw new PerfloUnavailableError('Payments did not return access for this person');
  }

  /**
   * Tiny knows nobody's name or email: the user types and proves their email
   * on Perflo's connect page. So only Tiny's own id is sent, with the look the
   * connect page is to be drawn in.
   */
  private userBody(user: DemoUser) {
    return { external_user_id: user.id, ...lookFields(user.look ?? DEFAULT_LOOK) };
  }

  /** The look Perflo's pages are opened in from now on. A page already open keeps the look it was opened with. */
  setLook(user: DemoUser, look: LookId): DemoUser {
    const updated = this.store.updateUser(user.id, (u) => (u.look = look));
    this.log.add(user.id, 'demo', `Look for Perflo pages: ${look}`);
    return updated;
  }

  /**
   * The connection to open with UI elements, an embedded page or the chat's setup: the one waiting, once
   * Perflo says it still works, else a new one. Linked already: nothing to open.
   */
  async connect(user: DemoUser): Promise<ConnectView> {
    const { user: fresh, status } = await this.ensureLinked(user);
    if (status === 'linked' || !fresh.pendingConnection) return { link: 'linked' };
    const { connectUrl, clientSecret } = fresh.pendingConnection;
    return { link: 'connection_required', page: { url: connectUrl, ...(clientSecret ? { clientSecret } : {}) } };
  }

  /**
   * Makes sure we hold an access token for this user, or a connection for them that works. A stored
   * connection is never handed out on trust: it stops working 30 minutes after Perflo opened it, so
   * Perflo is asked about it first (GET /v1/connections/{connection_id}). Finished: the user is
   * linked. Expired: a new one is opened. If Perflo cannot be reached this throws and the user is told
   * to try again; a connection nobody checked is never the answer. One per user at a time (the link
   * lock), so two pages opening at once make one connection.
   */
  async ensureLinked(user: DemoUser): Promise<{ user: DemoUser; status: LinkStatus }> {
    return this.exclusive(`link:${user.id}`, async () => {
      let fresh = this.store.user(user.id);
      if (fresh.perflo) return { user: fresh, status: 'linked' };
      if (fresh.pendingConnection) {
        const looked = await this.lookAtConnection(fresh);
        if (looked.status !== 'expired') {
          return { user: looked.user, status: looked.status === 'linked' ? 'linked' : 'connection_required' };
        }
        fresh = looked.user;
        this.log.add(fresh.id, 'demo', 'Connection expired: starting a new one');
      }

      const result = await this.api.createUser(fresh.id, this.userBody(fresh));
      if (result.status === 'approved') {
        if (result.user_access_token) {
          return { user: this.storeToken(fresh, result.user_id, result.user_access_token), status: 'linked' };
        }
        // Perflo already has access for this person but we hold no token (our
        // store was reset, or the link happened elsewhere). Ask for a new one.
        this.log.add(fresh.id, 'demo', 'Already approved without a stored token: asking for a new one');
        return { user: await this.reissue(fresh), status: 'linked' };
      }
      const updated = this.store.updateUser(fresh.id, (u) => (u.pendingConnection = waitingOn(result, null)));
      return { user: updated, status: 'connection_required' };
    });
  }

  /** Called when the page says the user connected or finished setup: asks Perflo, never decides alone. */
  async refreshConnection(user: DemoUser): Promise<{ user: DemoUser; status: LinkStatus }> {
    return this.exclusive(`link:${user.id}`, async () => {
      const fresh = this.store.user(user.id);
      if (!fresh.pendingConnection) {
        return { user: fresh, status: fresh.perflo ? 'linked' : 'expired' };
      }
      return this.lookAtConnection(fresh);
    });
  }

  /**
   * Where the stored connection stands, by Perflo's word: linked (a token Perflo hands out here is stored
   * at once: it is handed out once), pending, or expired (then it is cleared). Runs under the link lock.
   */
  private async lookAtConnection(fresh: DemoUser): Promise<{ user: DemoUser; status: LinkStatus }> {
    const pending = fresh.pendingConnection;
    if (!pending) return { user: fresh, status: fresh.perflo ? 'linked' : 'expired' };
    const connection = await this.api.getConnection(fresh.id, pending.connectionId);
    if (connection.status === 'pending') return { user: fresh, status: 'pending' };
    if (connection.status === 'expired') {
      return { user: this.store.updateUser(fresh.id, (u) => (u.pendingConnection = null)), status: 'expired' };
    }
    if (connection.user_access_token) {
      return { user: this.storeToken(fresh, connection.user_id, connection.user_access_token), status: 'linked' };
    }
    // Approved, but the token was already handed out once and we do not have it.
    if (fresh.perflo && fresh.perflo.userId === connection.user_id) {
      return { user: this.store.updateUser(fresh.id, (u) => (u.pendingConnection = null)), status: 'linked' };
    }
    return { user: await this.reissue(fresh), status: 'linked' };
  }

  private orderBody(order: DemoOrder, userId: string) {
    return {
      user_id: userId,
      merchant: { name: order.intent.merchantName, domain: order.intent.domain },
      amount: centsToApiAmount(order.intent.amountCents),
      currency: 'USD' as const,
      ...(order.intent.description ? { description: order.intent.description } : {}),
      external_order_id: order.id,
      // The look fixed on the order when it was made, so a second POST with its Idempotency-Key is the same body.
      ...lookFields(order.look ?? DEFAULT_LOOK),
    };
  }

  /**
   * Moves a chat order forward by one step: place it if it was never placed,
   * otherwise look at its current state (the only retry SPEC 4 allows).
   */
  async advanceOrder(user: DemoUser, orderId: string): Promise<{ order: DemoOrder; user: DemoUser; notice: Notice }> {
    const run = this.exclusive(`order:${orderId}`, () => this.advanceOrderNow(user, orderId));
    if (this.store.order(user.id, orderId)?.perfloOrderId === null) {
      this.placing.add(run);
      void run.catch(() => undefined).finally(() => this.placing.delete(run));
    }
    return run;
  }

  private async advanceOrderNow(user: DemoUser, orderId: string): Promise<{ order: DemoOrder; user: DemoUser; notice: Notice }> {
    let current = this.store.user(user.id);
    const order = this.store.order(current.id, orderId);
    if (!order) throw new DemoError('not_found', 'That order was not found');
    if (order.state === 'discarded') throw new DemoError('conflict', 'That order was cancelled before it was sent');
    if (order.last && TERMINAL_STATUSES.has(order.last.status)) return { order, user: current, notice: null };

    let response: OrderResponse;
    if (order.perfloOrderId === null) {
      this.store.updateOrder(order, (o) => (o.state = 'placing'));
      if (!current.perflo) {
        const link = await this.ensureLinked(current);
        current = link.user;
        if (link.status !== 'linked' || !current.perflo) return { order, user: current, notice: null };
      }
      try {
        response = await this.api.createOrder(
          current.id,
          current.perflo.token,
          order.idempotencyKey,
          this.orderBody(order, current.perflo.userId),
        );
      } catch (error) {
        if (!isUserTokenRefused(error)) throw error;
        // Our token is not accepted any more: drop it and link again.
        this.log.add(current.id, 'demo', 'Access token refused: setting up access again');
        current = this.store.updateUser(current.id, (u) => (u.perflo = null));
        const link = await this.ensureLinked(current);
        current = link.user;
        if (link.status !== 'linked' || !current.perflo) return { order, user: current, notice: null };
        response = await this.api.createOrder(
          current.id,
          current.perflo.token,
          order.idempotencyKey,
          this.orderBody(order, current.perflo.userId),
        );
      }
      if (response.status === 'identity_check_required' && !response.kyc_url) {
        // A replay (or a link that could not be made yet) carries no ID check link: ask for the order's state.
        response = await this.api.getOrder(current.id, response.order_id);
      }
    } else {
      response = await this.api.getOrder(current.id, order.perfloOrderId);
    }
    return this.handle(current, order, response);
  }

  /**
   * Brings the person's orders that are still moving up to date with Perflo
   * before they are listed: a plain status read (GET) per order, never a new
   * order. An order another flow is working on right now is left to that flow.
   * A read that fails keeps the last known status and says so in the log.
   */
  async refreshOrders(user: DemoUser): Promise<void> {
    const current = this.store.user(user.id);
    if (!current.perflo) return;
    const moving = this.store
      .ordersFor(current.id)
      .filter((o) => o.perfloOrderId !== null && o.last !== null && !TERMINAL_STATUSES.has(o.last.status));
    for (const order of moving) {
      const key = `order:${order.id}`;
      if (this.locks.has(key)) continue;
      await this.exclusive(key, async () => {
        const fresh = this.store.user(current.id);
        if (!fresh.perflo || order.perfloOrderId === null) return;
        try {
          const latest = await this.api.getOrder(fresh.id, order.perfloOrderId);
          if (latest.status === 'connection_required') {
            // Access was removed: same handling as any other read of this order.
            await this.handle(fresh, order, latest, { checkout: false });
            return;
          }
          this.store.updateOrder(order, (o) => recordAnswer(o, latest));
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unknown error';
          this.log.add(fresh.id, 'demo', `Could not refresh order ${order.perfloOrderId}: ${reason}`);
        }
      });
    }
  }

  /**
   * A signed webhook from Perflo, already checked and new (see app.ts). It only says "look now": the
   * order is read again from Perflo (the source of truth), Tiny does what it does with that answer
   * (on a ready card, the checkout), and the person's open pages are told. A read Perflo could not
   * answer is tried again a couple of times; after that the page catches up when it is next opened.
   */
  async onWebhook(event: WebhookEvent): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (event.type.startsWith('order.')) await this.onOrderEvent(event);
        else if (event.type === 'user.connected' || event.type === 'user.disconnected') await this.onUserEvent(event);
        else if (event.type === 'card.closed') await this.onCardClosed(event);
        else this.log.add(null, 'webhook', event.type === 'ping' ? 'Test event from Perflo received' : `Event ${event.type} ignored`);
        return;
      } catch (error) {
        const delay = WEBHOOK_RETRY_DELAYS_MS[attempt];
        if (!(error instanceof PerfloUnavailableError) || delay === undefined) {
          const reason = error instanceof Error ? error.message : 'unknown error';
          this.log.add(null, 'webhook', `Could not act on ${event.type}: ${reason}`);
          return;
        }
        await new Promise((done) => setTimeout(done, delay));
      }
    }
  }

  private async onOrderEvent(event: WebhookEvent): Promise<void> {
    const perfloOrderId = event.data.order_id;
    if (!perfloOrderId) return;
    let order = this.store.orderForWebhook(perfloOrderId);
    if (!order && this.placing.size > 0) {
      await Promise.allSettled([...this.placing]);
      order = this.store.orderForWebhook(perfloOrderId);
    }
    if (!order) {
      // Placed by another copy of Tiny sharing these partner credentials, or older than this store.
      this.log.add(null, 'webhook', `${event.type} for an order this copy of Tiny did not place`);
      return;
    }
    const user = this.store.user(order.demoUserId);
    this.log.add(user.id, 'webhook', `Perflo says ${event.type.slice('order.'.length).replace(/_/g, ' ')}`, {
      order_id: perfloOrderId,
      event_id: event.id,
    });
    const result = await this.advanceOrder(user, order.id);
    this.live.send(result.user.id, { type: 'order', order: toView(result.order, result.user), notice: result.notice });
    this.live.send(result.user.id, { type: 'account', linked: result.user.perflo !== null });
    this.live.send(result.user.id, { type: 'log' });
  }

  /**
   * A reused card closed: what each of its orders gave back is final now. Each order this copy of Tiny
   * placed is read again from Perflo (the source of truth) and its page told; any other is logged.
   */
  private async onCardClosed(event: WebhookEvent): Promise<void> {
    const data = cardClosedData.safeParse(event.data);
    if (!data.success) {
      this.log.add(null, 'webhook', 'card.closed without a readable list of orders', { event_id: event.id });
      return;
    }
    for (const { order_id: perfloOrderId } of data.data.orders) {
      const order = this.store.orderForWebhook(perfloOrderId);
      if (!order) {
        this.log.add(null, 'webhook', 'card.closed for an order this copy of Tiny did not place', {
          order_id: perfloOrderId,
          event_id: event.id,
        });
        continue;
      }
      const user = this.store.user(order.demoUserId);
      await this.exclusive(`order:${order.id}`, async () => {
        const latest = await this.api.getOrder(user.id, perfloOrderId);
        this.store.updateOrder(order, (o) => recordAnswer(o, latest));
      });
      this.log.add(user.id, 'webhook', 'Perflo says the card closed', { order_id: perfloOrderId, event_id: event.id });
      const fresh = this.store.user(user.id);
      this.live.send(fresh.id, { type: 'order', order: toView(order, fresh), notice: null });
      this.live.send(fresh.id, { type: 'account', linked: fresh.perflo !== null });
      this.live.send(fresh.id, { type: 'log' });
    }
  }

  /**
   * A signed event names a Perflo person and the Tiny account Tiny gave Perflo. Neither links nor
   * unlinks anything by itself: user.connected only wakes the page of an account waiting on a connection
   * (the page links with its own request, which rotates its session), and user.disconnected only
   * makes Tiny ask Perflo again about the person this account is linked to.
   */
  private async onUserEvent(event: WebhookEvent): Promise<void> {
    const external = event.data.external_user_id;
    const user = external ? this.store.findUser(external) : null;
    const connected = event.type === 'user.connected';
    const forThisAccount = user !== null && (connected ? user.pendingConnection !== null : user.perflo?.userId === event.data.user_id);
    if (!user || !forThisAccount) {
      this.log.add(null, 'webhook', `${event.type} for no account here waiting on it`, { event_id: event.id });
      return;
    }
    this.log.add(user.id, 'webhook', connected ? 'Perflo says payments were set up' : 'Perflo says payments were turned off', {
      event_id: event.id,
    });
    if (connected) {
      this.live.send(user.id, { type: 'connected' });
    } else {
      // Asking Perflo is what decides: a refused token is dropped there (see account()).
      await this.account(user);
    }
    const fresh = this.store.user(user.id);
    this.live.send(fresh.id, { type: 'account', linked: fresh.perflo !== null });
    this.live.send(fresh.id, { type: 'log' });
  }

  private async handle(
    user: DemoUser,
    order: DemoOrder,
    response: OrderResponse,
    options: { checkout: boolean } = { checkout: true },
  ): Promise<{ order: DemoOrder; user: DemoUser; notice: Notice }> {
    this.store.updateOrder(order, (o) => {
      o.perfloOrderId = response.order_id;
      o.state = 'placed';
      recordAnswer(o, response);
    });
    const step = nextStep(response, order);

    if (step === 'connect' && response.status === 'connection_required') {
      if (user.perflo && (await this.account(user)) !== null) {
        // Perflo still takes our token: the user connected again (on a new connection Tiny opened when
        // this order's own one had ended), and Perflo moves the order on by itself within a minute.
        // Dropping the token here would undo that connection.
        this.log.add(user.id, 'demo', 'Payments are on again: waiting for the order to go ahead');
        return { order, user: this.store.user(user.id), notice: null };
      }
      // The user removed access; the old token is dead. Reconnecting resumes this order.
      const updated = this.store.updateUser(user.id, (u) => {
        u.perflo = null;
        // A connection already waiting is kept: it is checked with Perflo before it is handed out, and
        // finishing it turns access back on just the same. Perflo never renews an order's own connection.
        if (u.pendingConnection === null) u.pendingConnection = waitingOn(response, order.id);
      });
      return { order, user: updated, notice: null };
    }

    if (options.checkout && step === 'reveal' && response.status === 'ready') {
      const notice = await this.checkoutWithCard(user, order, response);
      return { order, user, notice };
    }
    return { order, user, notice: null };
  }

  private async checkoutWithCard(user: DemoUser, order: DemoOrder, response: Extract<OrderResponse, { status: 'ready' }>): Promise<Notice> {
    if (!user.perflo || order.perfloOrderId === null) return 'reveal_failed';
    let revealUrl: string;
    if (response.reveal_url && !order.revealUsed) {
      revealUrl = response.reveal_url;
    } else {
      revealUrl = (await this.api.cardReveal(user.id, order.perfloOrderId, user.perflo.token)).reveal_url;
    }
    // Single use: mark before reading, so a failure asks for a fresh link next time.
    this.store.updateOrder(order, (o) => (o.revealUsed = true));

    try {
      const card = await revealCard(revealUrl, { credentials: this.config.credentials, userToken: user.perflo.token }, this.fetchImpl);
      this.log.add(user.id, 'demo', `Card details read for checkout (card ending ${card.last4})`);
      const summary = await simulateCheckout(
        card,
        order.intent,
        response.card_limit,
        this.config.mode === 'mock' && !user.testStopAtCheckout ? `${this.config.perfloOrigin}/mock-merchant/checkout` : null,
        this.fetchImpl,
      );
      this.store.updateOrder(order, (o) => (o.checkout = summary));
      this.log.add(user.id, 'demo', `Checkout on ${order.intent.domain}: ${summary.outcome.replace(/_/g, ' ')}`);
    } catch (error) {
      const code = error instanceof RevealError ? error.code : 'unavailable';
      this.log.add(user.id, 'demo', `Card details could not be read (${code})`);
      return code === 'still_locked' ? 'card_locked' : 'reveal_failed';
    }

    if (order.checkout?.outcome === 'charged' && order.perfloOrderId) {
      // The mock merchant spent the card; pick up the order's final state.
      const latest = await this.api.getOrder(user.id, order.perfloOrderId);
      this.store.updateOrder(order, (o) => recordAnswer(o, latest));
    }
    return null;
  }

  async cancelCard(user: DemoUser, perfloOrderId: string): Promise<{ amountReturned: string | null; order: DemoOrder | null }> {
    if (!user.perflo) throw new DemoError('not_linked', 'Payments are not set up yet');
    const token = user.perflo.token;
    return this.exclusive(`cancel:${perfloOrderId}`, async () => {
      const result = await this.api.cancelOrder(user.id, perfloOrderId, token);
      const order = this.store.orderByPerfloId(user.id, perfloOrderId);
      if (order) {
        const latest = await this.api.getOrder(user.id, perfloOrderId);
        this.store.updateOrder(order, (o) => {
          o.amountReturned = result.amount_returned;
          recordAnswer(o, latest);
        });
      }
      return { amountReturned: result.amount_returned, order };
    });
  }

  /**
   * The full card, for the person to see: a fresh single-use reveal link every
   * time, read through the relay that decrypts it. Returned to the caller only;
   * never stored, and the log records just the last four digits.
   */
  async cardDetails(user: DemoUser, perfloOrderId: string): Promise<RevealedCard> {
    const order = this.store.orderByPerfloId(user.id, perfloOrderId);
    if (!order) throw new DemoError('not_found', 'That order was not found.');
    if (!user.perflo) throw new DemoError('not_linked', 'Payments are not set up yet');
    const closed = new DemoError('conflict', 'This card is closed, so there are no details to show.');
    if (order.last !== null && TERMINAL_STATUSES.has(order.last.status)) throw closed;

    let revealUrl: string;
    try {
      revealUrl = (await this.api.cardReveal(user.id, perfloOrderId, user.perflo.token)).reveal_url;
    } catch (error) {
      if (error instanceof PerfloApiError && error.code === 'card_not_open') throw closed;
      throw error;
    }
    try {
      const card = await revealCard(revealUrl, { credentials: this.config.credentials, userToken: user.perflo.token }, this.fetchImpl);
      this.log.add(user.id, 'demo', `Card details shown to the person (card ending ${card.last4})`);
      return card;
    } catch (error) {
      const code = error instanceof RevealError ? error.code : 'unavailable';
      this.log.add(user.id, 'demo', `Card details could not be read (${code})`);
      throw new DemoError(
        'conflict',
        code === 'still_locked'
          ? 'The card details are not ready yet. Try again in a moment.'
          : 'Could not open the card details. Try again.',
      );
    }
  }

  /** null when this person has not set up payments, or their access was removed. */
  async account(user: DemoUser): Promise<AccountResponse | null> {
    if (!user.perflo) return null;
    try {
      return await this.api.getAccount(user.id, user.perflo.userId, user.perflo.token);
    } catch (error) {
      if (isUserTokenRefused(error)) {
        this.store.updateUser(user.id, (u) => (u.perflo = null));
        return null;
      }
      throw error;
    }
  }

  async limitsLink(user: DemoUser): Promise<PerfloPageView> {
    if (!user.perflo) throw new DemoError('not_linked', 'Payments are not set up yet');
    const link = await this.api.limitsLink(user.id, user.perflo.userId, user.perflo.token, lookFields(user.look ?? DEFAULT_LOOK));
    return pageOf(link);
  }

  /**
   * Perflo's add money page for exactly the amount the person typed in Tiny (Perflo asks for no amount
   * on its page), with the amount Perflo says it is for.
   */
  async topUpLink(user: DemoUser, amountCents: number): Promise<PerfloPageView & { amount: string }> {
    if (!user.perflo) throw new DemoError('not_linked', 'Payments are not set up yet');
    const link = await this.api.createTopUp(
      user.id,
      user.perflo.userId,
      user.perflo.token,
      centsToApiAmount(amountCents),
      lookFields(user.look ?? DEFAULT_LOOK),
    );
    return { ...pageOf(link), amount: link.amount };
  }

  /** The card element's client_secret, opened in the person's current look. */
  async linkedCardForm(user: DemoUser): Promise<{ clientSecret: string }> {
    const perflo = this.linkedOrThrow(user);
    const form = await this.api.linkedCardForm(user.id, perflo.userId, perflo.token, lookFields(user.look ?? DEFAULT_LOOK));
    return { clientSecret: form.client_secret };
  }

  /**
   * Saves the card behind one card token. Each Save makes a new token, so each Save gets its own
   * Idempotency-Key, from that token. "Try again" sends the same token again. After no answer at all it
   * keeps the key, so Perflo replays the first send if it got through. After an answered failure on
   * Perflo's side (a 5xx, such as a 503 while payments are down) it takes a new key: Perflo records that
   * answer under the old key and would only replay it, and it gives the card token back after an outage,
   * so the new key links it once (payments key the link on the token).
   * One at a time per token, so a double click waits for the first answer and gets the same one.
   */
  async linkCard(user: DemoUser, cardToken: string, autoTopUp: AutoTopUpChoice): Promise<LinkCardView> {
    const perflo = this.linkedOrThrow(user);
    const base = linkCardIdempotencyKey(user.id, cardToken, autoTopUp);
    return this.exclusive(`link-card:${base}`, async () => {
      const generation = this.linkKeyGenerations.get(base) ?? 0;
      let answer: LinkCardResponse;
      try {
        answer = await this.api.linkCard(user.id, perflo.userId, perflo.token, `${base}-${generation}`, {
          card_token: cardToken,
          auto_top_up: autoTopUp ? { monthly_limit: autoTopUp.monthlyLimit } : null,
        });
      } catch (error) {
        const noAnswer = error instanceof PerfloUnavailableError && error.retryable;
        const failedThere =
          (error instanceof PerfloApiError && error.httpStatus >= 500) || (error instanceof PerfloUnavailableError && !error.retryable);
        if (failedThere) this.linkKeyGenerations.set(base, generation + 1);
        else if (!noAnswer) this.linkKeyGenerations.delete(base);
        if (error instanceof PerfloApiError && error.code === 'conflict') {
          // The one conflict on this route: Tiny's brand is not published in Perflo, so no card can be linked.
          throw new DemoError(
            'conflict',
            'Saving a card is not available in Tiny yet. Try again later.',
            'payments refused the link because Tiny has no published brand: publish it in Perflo Builder',
          );
        }
        throw error;
      }
      this.linkKeyGenerations.delete(base);
      if (answer.status === 'requires_action') {
        this.log.add(user.id, 'demo', 'The card needs confirming in the card form');
        return { status: 'requires_action' };
      }
      this.log.add(
        user.id,
        'demo',
        `Card ending ${answer.linked_card.last4} linked${answer.auto_top_up ? `, automatic top-ups on up to ${answer.auto_top_up.monthly_limit} a month` : ''}`,
      );
      return {
        status: 'linked',
        linkedCard: cardView(answer.linked_card),
        autoTopUp: answer.auto_top_up ? { status: 'on', monthlyLimit: answer.auto_top_up.monthly_limit } : null,
      };
    });
  }

  async linkedCards(user: DemoUser): Promise<LinkedCardView[]> {
    const perflo = this.linkedOrThrow(user);
    const { linked_cards } = await this.api.linkedCards(user.id, perflo.userId, perflo.token);
    return linked_cards.map((card) => ({ ...cardView(card), usedForAutoTopUp: card.used_for_auto_top_up }));
  }

  /** Perflo turns automatic top-ups off when they were using this card. */
  async removeLinkedCard(user: DemoUser, linkedCardId: string): Promise<void> {
    const perflo = this.linkedOrThrow(user);
    await this.api.removeLinkedCard(user.id, perflo.userId, perflo.token, linkedCardId);
  }

  async autoTopUp(user: DemoUser): Promise<AutoTopUpView> {
    const perflo = this.linkedOrThrow(user);
    const state = await this.api.autoTopUp(user.id, perflo.userId, perflo.token);
    return { status: state.status, monthlyLimit: state.monthly_limit, linkedCardId: state.linked_card_id };
  }

  /** The card stays linked. Already off is a success. */
  async turnOffAutoTopUp(user: DemoUser): Promise<void> {
    const perflo = this.linkedOrThrow(user);
    await this.api.turnOffAutoTopUp(user.id, perflo.userId, perflo.token);
  }

  private linkedOrThrow(user: DemoUser): NonNullable<DemoUser['perflo']> {
    if (!user.perflo) throw new DemoError('not_linked', 'Payments are not set up yet');
    return user.perflo;
  }
}

/**
 * The Idempotency-Key for linking the card behind one card token: the same Save (account, token and
 * choice) always gives the same key, and nothing about the token can be read back from it.
 */
export function linkCardIdempotencyKey(demoUserId: string, cardToken: string, autoTopUp: AutoTopUpChoice): string {
  const hash = createHash('sha256')
    .update(['linked-card', demoUserId, cardToken, autoTopUp ? autoTopUp.monthlyLimit : ''].join('\n'), 'utf8')
    .digest('hex');
  return `lc-save-${hash}`;
}

function cardView(card: LinkedCard): Omit<LinkedCardView, 'usedForAutoTopUp'> {
  return { id: card.id, brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year };
}

/** The connection an answer names, as Tiny stores it while it waits (store.ts DemoUser.pendingConnection). */
function waitingOn(
  answer: { connection_id: string; connect_url: string; client_secret?: string | null },
  orderId: string | null,
): NonNullable<DemoUser['pendingConnection']> {
  return {
    connectionId: answer.connection_id,
    connectUrl: answer.connect_url,
    ...(answer.client_secret ? { clientSecret: answer.client_secret } : {}),
    orderId,
  };
}

/** A page Perflo opened, as the person's page gets it: its link, and its client_secret when Perflo sent one. */
function pageOf(link: { frame_url: string; client_secret?: string }): PerfloPageView {
  return { url: link.frame_url, ...(link.client_secret ? { clientSecret: link.client_secret } : {}) };
}
