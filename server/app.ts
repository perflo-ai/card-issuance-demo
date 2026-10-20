/**
 * Tiny's own backend, as the demo browser sees it. The browser talks only to
 * these /demo routes; this server holds the partner secret and every user
 * access token and is the only thing that calls Perflo.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DemoConfig } from './config.js';
import type { EventLog } from './eventLog.js';
import { parseOrderMessage } from './intent.js';
import { DEFAULT_LOOK } from './looks.js';
import { formatUsd, readTypedAmount } from './money.js';
import { toView } from './orderState.js';
import { rateLimit, sameOriginOnly, securityHeaders } from './security.js';
import { HttpError, toBrowserError } from './errors.js';
import { requestLog, type Logger } from './logger.js';
import type { DemoService } from './service.js';
import { SESSION_TTL_MS, type DemoUser, type Store } from './store.js';
import { FRAME_EVENT_TYPES, LOOK_IDS, type CardDetailsView, type DemoConfigView, type MeView } from './views.js';
import { verifyWebhook, WEBHOOK_PATH, webhookEvent } from './webhooks.js';

const SESSION_COOKIE = 'tiny_session';
/** The test control talks to the mock on this computer; it never needs long. */
const MOCK_CONTROL_TIMEOUT_MS = 5_000;

/** Ids as Tiny makes them (order ids are uuids) and as Perflo sends them (opaque, url-safe). */
const demoOrderId = z.string().uuid();
const perfloOrderId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const noBody = z.object({}).strict();
/** A look is named by its id only: the appearance Perflo gets comes from server/looks.ts, never from here. */
const lookBody = z.object({ look: z.enum(LOOK_IDS) }).strict();
const eventsQuery = z.object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) });

const frameEvent = z.object({
  type: z.enum(FRAME_EVENT_TYPES),
  frame_session_id: z.string().max(200),
  connection_id: z.string().max(200).optional(),
  top_up_id: z.string().max(200).optional(),
  order_id: z.string().max(200).optional(),
  code: z.string().max(100).optional(),
});

function sessionId(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}

export interface DemoAppDeps {
  config: DemoConfig;
  store: Store;
  service: DemoService;
  log: EventLog;
  /** The operator's log (stdout). */
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** The built web app is served by this process (strict content security policy). */
  production?: boolean;
}

export function chatReply(text: string): { reply: string; intent?: ReturnType<typeof parseOrderMessage> & { kind: 'order' } } {
  const parsed = parseOrderMessage(text);
  if (parsed.kind === 'order') {
    const { amountCents, domain, description } = parsed.intent;
    return {
      reply: `Got it: ${formatUsd(amountCents)} at ${domain}${description ? ` for ${description}` : ''}. Should I go ahead?`,
      intent: parsed,
    };
  }
  if (parsed.kind === 'incomplete') {
    if (parsed.problem === 'amount_zero') return { reply: 'The amount needs to be more than $0.00.' };
    if (parsed.problem === 'amount_too_large') return { reply: 'That amount is too large for one order.' };
    if (parsed.missing.includes('amount') && parsed.missing.includes('merchant')) {
      return {
        reply: 'Tell me what to buy, how much to spend and on which website. For example: buy me $50 worth of headphones on amazon.',
      };
    }
    if (parsed.missing.includes('amount')) {
      return {
        reply:
          'How much should I spend? Send the whole request again with the amount, for example: buy me $50 worth of headphones on amazon.',
      };
    }
    return { reply: 'Which website should I buy from? Send the request again with the website, for example: on amazon.com.' };
  }
  return {
    reply: 'I can buy things for you. Try: buy me $50 worth of headphones on amazon, or book the 412.80 flight on united.com.',
  };
}

export function createDemoApp({ config, store, service, log, logger, fetchImpl = fetch, production = false }: DemoAppDeps) {
  const hosted = config.listen.kind === 'hosted';
  const app = express();
  app.disable('x-powered-by');
  // A host's proxy sits in front: the client address and the public host name come from its headers.
  if (hosted) app.set('trust proxy', 1);
  app.use(requestLog(logger));
  app.use(securityHeaders({ perfloOrigin: config.perfloOrigin, production, hosted }));

  // For the host's health check: no session, no rate limit, nothing about anyone.
  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });

  /**
   * Perflo's webhooks: server to server, so no session, no Origin check and no CSRF rules apply. The
   * signature is what proves Perflo sent it, checked over the raw bytes before anything parses them.
   * A new event is answered at once and acted on after, so Perflo never waits on Tiny's own calls.
   */
  app.post(WEBHOOK_PATH, rateLimit({ windowMs: 60_000, max: 600 }), express.raw({ type: () => true, limit: '64kb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const checked = verifyWebhook(req.headers, req.path, raw, config.webhookSecret);
    if (!checked.ok) {
      logger.warn('webhook refused', { request_id: req.requestId, reason: checked.reason });
      res.status(401).json({ error: { message: 'Signature not accepted.' } });
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString('utf8'));
    } catch {
      parsedJson = null;
    }
    const event = webhookEvent.safeParse(parsedJson);
    if (!event.success || event.data.id !== checked.eventId) {
      logger.warn('webhook unreadable', { request_id: req.requestId });
      res.status(400).json({ error: { message: 'The event could not be read.' } });
      return;
    }
    if (!store.rememberWebhookEvent(event.data.id)) {
      // A retry of an event already handled: answered, not acted on twice.
      res.json({ received: true, duplicate: true });
      return;
    }
    res.json({ received: true });
    void service.onWebhook(event.data);
  });

  // Generous for one person's page, tight for a script.
  app.use('/demo', rateLimit({ windowMs: 60_000, max: 300 }));
  // Each new browser makes an account in the store: few per address.
  app.use(
    '/demo/session',
    rateLimit({ windowMs: 10 * 60_000, max: 20, counts: (req) => req.method === 'POST' && !store.userForSession(sessionId(req)) }),
  );
  /**
   * CSRF. Every state-changing route refuses a request whose Origin is not Tiny's own (a page on
   * another site cannot send ours), the session cookie is SameSite=Strict, and a POST must carry a
   * JSON body, which a cross-site form cannot send.
   */
  app.use('/demo', sameOriginOnly({ publicOrigin: config.publicOrigin, trustProxy: hosted }));
  app.use('/demo', express.json({ limit: '16kb' }));
  app.use('/demo', (req, res, next) => {
    // req.is() is null for a request with no body and false for a body of another type: both are refused.
    if (req.method === 'POST' && !req.is('application/json')) {
      next(new HttpError(415, 'Send JSON.'));
      return;
    }
    // Balances, orders and card details are this person's alone: never kept by a browser or proxy cache.
    res.set('Cache-Control', 'no-store');
    next();
  });

  /**
   * SameSite=Strict: the cookie is only ever needed on the page's own requests to this origin, so no
   * request started from another site (not even a link a person follows) carries it. Secure always:
   * locally the demo is https, and a host serves it over https in front.
   */
  const setSession = (res: Response, sid: string) =>
    res.cookie(SESSION_COOKIE, sid, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: SESSION_TTL_MS });

  /** When this request linked the account to Perflo, the browser gets a new session id (see Store.rotateSession). */
  const rotateIfLinked = (req: Request, res: Response, user: DemoUser, wasLinked: boolean) => {
    if (wasLinked || store.user(user.id).perflo === null) return;
    const sid = sessionId(req);
    const fresh = sid ? store.rotateSession(sid) : null;
    if (!sid || !fresh) return;
    setSession(res, fresh);
    // A live feed opened with the old id is closed; the page opens it again with the new one.
    service.live.closeSession(sid);
  };

  const parse = <T>(schema: z.ZodType<T>, value: unknown, error: HttpError): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw error;
    return result.data;
  };
  const notFound = new HttpError(404, 'That order was not found.');
  const unreadable = new HttpError(400, 'The request could not be read.');

  const currentUser = (req: Request): DemoUser => {
    const user = store.userForSession(sessionId(req));
    if (!user) throw new HttpError(401, 'Sign in to continue.');
    return user;
  };

  const meView = (user: DemoUser): MeView => ({
    linked: user.perflo !== null,
    stopAtCheckout: user.testStopAtCheckout === true,
    look: user.look ?? DEFAULT_LOOK,
  });

  app.get('/demo/config', (_req, res) => {
    const view: DemoConfigView = {
      mode: config.mode,
      perfloOrigin: config.perfloOrigin,
      // Perflo.js learns where Perflo is from its own address, so it is loaded from exactly the API base.
      perfloScriptUrl: config.mode === 'live' ? `${config.perfloApiBase}/v1/perflo.js` : null,
    };
    res.json(view);
  });

  /**
   * The browser's Tiny account: the one its session cookie names, or a new
   * anonymous one (no name, no email) on a first visit. Nothing personal is
   * asked for; the person proves their email to Perflo on its connect page.
   */
  app.post('/demo/session', (req, res) => {
    parse(noBody, req.body, unreadable);
    // Only ever this browser's own cookie, or a new account: no id is accepted from the request.
    const existing = store.userForSession(sessionId(req));
    if (existing) return res.json({ user: meView(existing) });
    const { user, sessionId: sid } = store.createUser();
    log.add(user.id, 'demo', 'New visit to Tiny');
    setSession(res, sid);
    res.json({ user: meView(user) });
  });

  app.post('/demo/logout', (req, res) => {
    parse(noBody, req.body, unreadable);
    const sid = sessionId(req);
    if (sid) {
      store.endSession(sid);
      service.live.closeSession(sid);
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.post('/demo/chat', (req, res) => {
    const user = currentUser(req);
    const body = z
      .object({ text: z.string().max(500) })
      .strict()
      .safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Message is too long.');
    const { reply, intent } = chatReply(body.data.text);
    if (!intent) return res.json({ reply });
    const order = store.createOrder(user.id, intent.intent);
    log.add(user.id, 'demo', `Understood an order: ${formatUsd(intent.intent.amountCents)} at ${intent.intent.domain}`);
    res.json({ reply, order: toView(order, user) });
  });

  app.get('/demo/orders', async (req, res) => {
    const user = currentUser(req);
    await service.refreshOrders(user);
    const fresh = store.user(user.id);
    res.json({ orders: store.ordersFor(fresh.id).map((o) => toView(o, fresh)) });
  });

  app.post('/demo/orders/:id/discard', (req, res) => {
    const user = currentUser(req);
    parse(noBody, req.body, unreadable);
    const order = store.order(user.id, parse(demoOrderId, req.params.id, notFound));
    if (!order) throw new HttpError(404, 'That order was not found.');
    if (order.state !== 'draft') throw new HttpError(409, 'That order was already sent.');
    store.updateOrder(order, (o) => (o.state = 'discarded'));
    res.json({ order: toView(order, user) });
  });

  app.post('/demo/orders/:id/advance', async (req, res) => {
    const user = currentUser(req);
    parse(noBody, req.body, unreadable);
    const wasLinked = user.perflo !== null;
    const result = await service.advanceOrder(user, parse(demoOrderId, req.params.id, notFound));
    rotateIfLinked(req, res, user, wasLinked);
    res.json({ order: toView(result.order, result.user), notice: result.notice, linked: result.user.perflo !== null });
  });

  app.post('/demo/frame-events', async (req, res) => {
    const user = currentUser(req);
    const event = frameEvent.safeParse(req.body);
    if (!event.success) throw new HttpError(400, 'Unknown frame event.');
    log.add(user.id, 'frame', event.data.type, event.data);
    if (event.data.type === 'perflo:connection_completed' || event.data.type === 'perflo:setup_completed') {
      // The event only says "look now". Which connection is looked at comes from this session's own
      // record (the one its order made), never from ids in the event.
      const wasLinked = user.perflo !== null;
      const { status } = await service.refreshConnection(user);
      rotateIfLinked(req, res, user, wasLinked);
      return res.json({ link: status });
    }
    res.json({});
  });

  /** The look Perflo's pages are opened in from now on, picked from Tiny's fixed list by its id. */
  app.post('/demo/look', (req, res) => {
    const user = currentUser(req);
    const body = lookBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Pick one of the looks shown.');
    res.json({ user: meView(service.setLook(user, body.data.look)) });
  });

  /** The connection the UI elements page and the chat's setup open: the one waiting, or a new one. */
  app.post('/demo/connect', async (req, res) => {
    const user = currentUser(req);
    parse(noBody, req.body, unreadable);
    const wasLinked = user.perflo !== null;
    const result = await service.connect(user);
    rotateIfLinked(req, res, user, wasLinked);
    res.json(result);
  });

  app.post('/demo/link/refresh', async (req, res) => {
    const user = currentUser(req);
    parse(noBody, req.body, unreadable);
    const wasLinked = user.perflo !== null;
    const { status } = await service.refreshConnection(user);
    rotateIfLinked(req, res, user, wasLinked);
    res.json({ link: status });
  });

  app.get('/demo/account', async (req, res) => {
    const user = currentUser(req);
    const account = await service.account(user);
    res.json(account ? { linked: true, account } : { linked: false });
  });

  app.post('/demo/limits-link', async (req, res) => {
    const user = currentUser(req);
    parse(noBody, req.body, unreadable);
    const page = await service.limitsLink(user);
    res.json({ frameUrl: page.url, ...(page.clientSecret ? { clientSecret: page.clientSecret } : {}) });
  });

  /** Add money: always the amount the person typed in Tiny's own field. Perflo's page asks for none. */
  app.post('/demo/top-ups', async (req, res) => {
    const user = currentUser(req);
    const body = z
      .object({ amount: z.string().max(20).optional() })
      .strict()
      .safeParse(req.body);
    const typed = readTypedAmount(body.success ? (body.data.amount ?? '') : '');
    if ('problem' in typed) throw new HttpError(400, typed.problem);
    const page = await service.topUpLink(user, typed.cents);
    res.json({ frameUrl: page.url, ...(page.clientSecret ? { clientSecret: page.clientSecret } : {}), amount: page.amount });
  });

  app.post('/demo/orders/:perfloOrderId/card-details', async (req, res) => {
    const user = currentUser(req);
    parse(noBody, req.body, unreadable);
    const card = await service.cardDetails(user, parse(perfloOrderId, req.params.perfloOrderId, notFound));
    const view: CardDetailsView = card;
    res.json({ card: view });
  });

  app.post('/demo/cards/:orderId/cancel', async (req, res) => {
    const user = currentUser(req);
    parse(noBody, req.body, unreadable);
    const result = await service.cancelCard(user, parse(perfloOrderId, req.params.orderId, notFound));
    res.json({
      amountReturned: result.amountReturned,
      ...(result.order ? { order: toView(result.order, store.user(user.id)) } : {}),
    });
  });

  /**
   * The page's live feed (Server-Sent Events): orders, access and the log, pushed as Perflo's
   * webhooks arrive. The page reads its state once when it opens or reconnects and never polls.
   */
  app.get('/demo/stream', (req, res) => {
    // A GET passes the Origin check, so a request another site started is refused here. Browsers that
    // send no Sec-Fetch-Site still never send the SameSite=Strict cookie from another site.
    const site = req.get('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Open Tiny itself to see updates.');
    // The session cookie alone picks the account: nothing in the query or path is read.
    const user = currentUser(req);
    if (!service.live.open(user.id, sessionId(req) as string, res))
      throw new HttpError(429, 'Too many Tiny pages are open. Close one and reload.');
  });

  app.get('/demo/events', (req, res) => {
    const user = currentUser(req);
    const { after } = parse(eventsQuery, req.query, unreadable);
    res.json({ events: log.forUser(user.id, after) });
  });

  // Mock mode only: simulates the person turning off Tiny's access, so connection_required can be shown.
  app.post('/demo/mock/revoke-access', async (req, res) => {
    if (config.mode !== 'mock') throw new HttpError(404, 'Not found.');
    const user = currentUser(req);
    parse(noBody, req.body, unreadable);
    if (!user.perflo) throw new HttpError(409, 'Payments are not set up yet.');
    let response: globalThis.Response;
    try {
      response = await fetchImpl(`${config.perfloOrigin}/mock/control/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: user.perflo.userId }),
        signal: AbortSignal.timeout(MOCK_CONTROL_TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(502, 'The test service did not answer. Try again.');
    }
    if (!response.ok) throw new HttpError(502, 'The test service did not accept that.');
    log.add(user.id, 'demo', 'Test control: access turned off on the payments side');
    res.json({ ok: true });
  });

  app.post('/demo/mock/stop-at-checkout', (req, res) => {
    if (config.mode !== 'mock') throw new HttpError(404, 'Not found.');
    const user = currentUser(req);
    const body = z.object({ on: z.boolean() }).strict().safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Send on: true or false.');
    const updated = store.updateUser(user.id, (u) => (u.testStopAtCheckout = body.data.on));
    res.json({ user: meView(updated) });
  });

  app.use('/demo', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const failure = toBrowserError(error);
    if (failure.operatorNote) {
      logger[failure.status >= 500 ? 'error' : 'warn']('request failed', {
        request_id: req.requestId,
        status: failure.status,
        note: failure.operatorNote,
      });
    }
    if (failure.retryAfterSeconds !== undefined) res.set('Retry-After', String(failure.retryAfterSeconds));
    res.status(failure.status).json({ error: { message: failure.message } });
  });

  return app;
}
