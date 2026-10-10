/**
 * The partner-side flow: everything Tiny's backend does against Perflo.
 */

import { randomUUID } from 'node:crypto';
import type { DemoConfig } from './config.js';
import type { EventLog } from './eventLog.js';
import { centsToApiAmount } from './money.js';
import { LiveUpdates } from './live.js';
import { nextStep, recordAnswer, TERMINAL_STATUSES, toView } from './orderState.js';
import {
  isUserTokenRefused,
  PerfloApiError,
  PerfloUnavailableError,
  type AccountResponse,
  type OrderResponse,
  type PerfloApi,
} from './perfloApi.js';
import { revealCard, RevealError, simulateCheckout, type RevealedCard } from './checkout.js';
import type { DemoOrder, DemoUser, Store } from './store.js';
import { cardClosedData, type WebhookEvent } from './webhooks.js';

import type { LinkStatus, Notice } from './views.js';

export type { LinkStatus, Notice } from './views.js';

export class DemoError extends Error {
  constructor(
    readonly code: 'not_linked' | 'not_found' | 'conflict' | 'bad_request',
    message: string,
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
   * Orders being placed right now. POST /orders can take a while, and Perflo may announce a change
   * to the order before its answer (with the order id) is stored here; such a webhook waits for these.
   */
  private readonly placing = new Set<Promise<unknown>>();
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
      if (again.status === 'login_required') {
        throw new DemoError('conflict', 'Payments need to be set up again. Send your request once more.');
      }
    }
    throw new PerfloUnavailableError('Payments did not return access for this person');
  }

  /**
   * Tiny knows nobody's name or email: the person types and proves their email
   * in Perflo's sign-in frame. So only Tiny's own id is sent.
   */
  private userBody(user: DemoUser) {
    return { external_user_id: user.id };
  }

  /** Makes sure we hold an access token for this person, or starts the one-time setup. */
  async ensureLinked(user: DemoUser): Promise<{ user: DemoUser; status: LinkStatus }> {
    return this.exclusive(`link:${user.id}`, async () => {
      const fresh = this.store.user(user.id);
      if (fresh.perflo) return { user: fresh, status: 'linked' };
      if (fresh.pendingLogin) return { user: fresh, status: 'login_required' };

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
      const updated = this.store.updateUser(fresh.id, (u) => {
        u.pendingLogin = { loginId: result.login_id, loginUrl: result.login_url, orderId: null };
      });
      return { user: updated, status: 'login_required' };
    });
  }

  /** Called when the frame says the person signed in or finished setup. */
  async refreshLogin(user: DemoUser): Promise<{ user: DemoUser; status: LinkStatus }> {
    return this.exclusive(`link:${user.id}`, async () => {
      const fresh = this.store.user(user.id);
      if (!fresh.pendingLogin) {
        return { user: fresh, status: fresh.perflo ? 'linked' : 'expired' };
      }
      const login = await this.api.getLogin(fresh.id, fresh.pendingLogin.loginId);
      if (login.status === 'pending') return { user: fresh, status: 'pending' };
      if (login.status === 'expired') {
        const cleared = this.store.updateUser(fresh.id, (u) => {
          u.pendingLogin = null;
        });
        return { user: cleared, status: 'expired' };
      }
      if (login.user_access_token) {
        return { user: this.storeToken(fresh, login.user_id, login.user_access_token), status: 'linked' };
      }
      // Approved, but the token was already handed out once and we do not have it.
      if (fresh.perflo && fresh.perflo.userId === login.user_id) {
        return { user: this.store.updateUser(fresh.id, (u) => (u.pendingLogin = null)), status: 'linked' };
      }
      return { user: await this.reissue(fresh), status: 'linked' };
    });
  }

  private orderBody(order: DemoOrder, userId: string) {
    return {
      user_id: userId,
      merchant: { name: order.intent.merchantName, domain: order.intent.domain },
      amount: centsToApiAmount(order.intent.amountCents),
      currency: 'USD' as const,
      ...(order.intent.description ? { description: order.intent.description } : {}),
      external_order_id: order.id,
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
          if (latest.status === 'login_required') {
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
   * unlinks anything by itself: user.connected only wakes the page of an account waiting on a sign-in
   * (the page links with its own request, which rotates its session), and user.disconnected only
   * makes Tiny ask Perflo again about the person this account is linked to.
   */
  private async onUserEvent(event: WebhookEvent): Promise<void> {
    const external = event.data.external_user_id;
    const user = external ? this.store.findUser(external) : null;
    const connected = event.type === 'user.connected';
    const forThisAccount = user !== null && (connected ? user.pendingLogin !== null : user.perflo?.userId === event.data.user_id);
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

    if (step === 'login' && response.status === 'login_required') {
      // The person removed access; the old token is dead. Login completion resumes this order.
      const updated = this.store.updateUser(user.id, (u) => {
        u.perflo = null;
        u.pendingLogin = { loginId: response.login_id, loginUrl: response.login_url, orderId: order.id };
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

  async limitsLink(user: DemoUser): Promise<string> {
    if (!user.perflo) throw new DemoError('not_linked', 'Payments are not set up yet');
    return (await this.api.limitsLink(user.id, user.perflo.userId, user.perflo.token)).frame_url;
  }

  async topUpLink(user: DemoUser, amountCents?: number): Promise<string> {
    if (!user.perflo) throw new DemoError('not_linked', 'Payments are not set up yet');
    const amount = amountCents === undefined ? undefined : centsToApiAmount(amountCents);
    return (await this.api.createTopUp(user.id, user.perflo.userId, user.perflo.token, amount)).frame_url;
  }
}
