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
import { formatUsd, parseDecimalToCents } from './money.js';
import { toView } from './orderState.js';
import { PerfloApiError, PerfloUnavailableError } from './perfloApi.js';
import { DemoError, type DemoService } from './service.js';
import type { DemoUser, Store } from './store.js';
import { FRAME_EVENT_TYPES, type CardDetailsView } from './views.js';

const SESSION_COOKIE = 'tiny_session';


const frameEvent = z.object({
  type: z.enum(FRAME_EVENT_TYPES),
  frame_session_id: z.string().max(200),
  login_id: z.string().max(200).optional(),
  top_up_id: z.string().max(200).optional(),
  order_id: z.string().max(200).optional(),
  code: z.string().max(100).optional(),
});

const signupBody = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(320),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

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
  fetchImpl?: typeof fetch;
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
      return { reply: 'Tell me what to buy, how much to spend and on which website. For example: buy me $50 worth of headphones on amazon.' };
    }
    if (parsed.missing.includes('amount')) {
      return { reply: 'How much should I spend? Send the whole request again with the amount, for example: buy me $50 worth of headphones on amazon.' };
    }
    return { reply: 'Which website should I buy from? Send the request again with the website, for example: on amazon.com.' };
  }
  return {
    reply: 'I can buy things for you. Try: buy me $50 worth of headphones on amazon, or book the 412.80 flight on united.com.',
  };
}

export function createDemoApp({ config, store, service, log, fetchImpl = fetch }: DemoAppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/demo', express.json({ limit: '16kb' }));

  // Cookie sessions plus JSON-only POSTs: a cross-site form cannot send application/json without a preflight.
  app.use('/demo', (req, _res, next) => {
    // req.is() is null for a bodyless request and false for a body of another type.
    if (req.method === 'POST' && req.is('application/json') === false) return next(new HttpError(415, 'Send JSON.'));
    next();
  });

  const currentUser = (req: Request): DemoUser => {
    const user = store.userForSession(sessionId(req));
    if (!user) throw new HttpError(401, 'Sign in to continue.');
    return user;
  };

  const meView = (user: DemoUser) => ({
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    linked: user.perflo !== null,
    stopAtCheckout: user.testStopAtCheckout === true,
  });

  app.get('/demo/config', (_req, res) => {
    res.json({ mode: config.mode, perfloOrigin: config.perfloOrigin });
  });

  app.post('/demo/signup', (req, res) => {
    const body = signupBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Enter your first name, last name and a valid email.');
    const { user, sessionId: sid } = store.createUser(body.data.first_name, body.data.last_name, body.data.email);
    log.add(user.id, 'demo', 'Signed in to Tiny');
    res.cookie(SESSION_COOKIE, sid, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    res.json({ user: meView(user) });
  });

  app.get('/demo/me', (req, res) => {
    res.json({ user: meView(currentUser(req)) });
  });

  app.post('/demo/logout', (req, res) => {
    const sid = sessionId(req);
    if (sid) store.endSession(sid);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.post('/demo/chat', (req, res) => {
    const user = currentUser(req);
    const body = z.object({ text: z.string().max(500) }).safeParse(req.body);
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
    const order = store.order(user.id, req.params.id);
    if (!order) throw new HttpError(404, 'That order was not found.');
    if (order.state !== 'draft') throw new HttpError(409, 'That order was already sent.');
    store.updateOrder(order, (o) => (o.state = 'discarded'));
    res.json({ order: toView(order, user) });
  });

  app.post('/demo/orders/:id/advance', async (req, res) => {
    const user = currentUser(req);
    const result = await service.advanceOrder(user, req.params.id);
    res.json({ order: toView(result.order, result.user), notice: result.notice, linked: result.user.perflo !== null });
  });

  app.post('/demo/frame-events', async (req, res) => {
    const user = currentUser(req);
    const event = frameEvent.safeParse(req.body);
    if (!event.success) throw new HttpError(400, 'Unknown frame event.');
    log.add(user.id, 'frame', event.data.type, event.data);
    if (event.data.type === 'perflo:login_completed' || event.data.type === 'perflo:setup_completed') {
      const { status } = await service.refreshLogin(user);
      return res.json({ link: status });
    }
    res.json({});
  });

  app.post('/demo/link/refresh', async (req, res) => {
    const user = currentUser(req);
    const { status } = await service.refreshLogin(user);
    res.json({ link: status });
  });

  app.get('/demo/account', async (req, res) => {
    const user = currentUser(req);
    const account = await service.account(user);
    res.json(account ? { linked: true, account } : { linked: false });
  });

  app.post('/demo/limits-link', async (req, res) => {
    const user = currentUser(req);
    res.json({ frameUrl: await service.limitsLink(user) });
  });

  app.post('/demo/top-ups', async (req, res) => {
    const user = currentUser(req);
    const body = z.object({ amount: z.string().max(20).optional() }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Enter an amount.');
    let cents: number | undefined;
    if (body.data.amount !== undefined && body.data.amount !== '') {
      const parsed = parseDecimalToCents(body.data.amount);
      if (parsed === null || parsed <= 0) throw new HttpError(400, 'Enter an amount above $0.00.');
      cents = parsed;
    }
    res.json({ frameUrl: await service.topUpLink(user, cents) });
  });

  app.post('/demo/orders/:perfloOrderId/card-details', async (req, res) => {
    const user = currentUser(req);
    const card = await service.cardDetails(user, req.params.perfloOrderId);
    res.set('Cache-Control', 'no-store');
    const view: CardDetailsView = card;
    res.json({ card: view });
  });

  app.post('/demo/cards/:orderId/cancel', async (req, res) => {
    const user = currentUser(req);
    const result = await service.cancelCard(user, req.params.orderId);
    res.json({
      amountReturned: result.amountReturned,
      ...(result.order ? { order: toView(result.order, store.user(user.id)) } : {}),
    });
  });

  app.get('/demo/events', (req, res) => {
    const user = currentUser(req);
    const after = Number(req.query.after ?? 0);
    res.json({ events: log.forUser(user.id, Number.isSafeInteger(after) ? after : 0) });
  });

  // Mock mode only: simulates the person turning off Tiny's access, so login_required can be shown.
  app.post('/demo/mock/revoke-access', async (req, res) => {
    if (config.mode !== 'mock') throw new HttpError(404, 'Not found.');
    const user = currentUser(req);
    if (!user.perflo) throw new HttpError(409, 'Payments are not set up yet.');
    const response = await fetchImpl(`${config.perfloOrigin}/mock/control/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user.perflo.userId }),
    });
    if (!response.ok) throw new HttpError(502, 'The test service did not accept that.');
    log.add(user.id, 'demo', 'Test control: access turned off on the payments side');
    res.json({ ok: true });
  });

  app.post('/demo/mock/stop-at-checkout', (req, res) => {
    if (config.mode !== 'mock') throw new HttpError(404, 'Not found.');
    const user = currentUser(req);
    const body = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Send on: true or false.');
    const updated = store.updateUser(user.id, (u) => (u.testStopAtCheckout = body.data.on));
    res.json({ user: meView(updated) });
  });

  app.use('/demo', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) return res.status(error.status).json({ error: { message: error.message } });
    if (error instanceof DemoError) {
      const status = error.code === 'not_found' ? 404 : error.code === 'bad_request' ? 400 : 409;
      return res.status(status).json({ error: { message: error.message } });
    }
    if (error instanceof PerfloUnavailableError) {
      return res.status(503).json({ error: { message: 'Payments are not reachable right now. Try again in a moment.' } });
    }
    if (error instanceof PerfloApiError) {
      // Perflo's messages are written for people (SPEC 4); anything else gets a generic line.
      const message =
        error.httpStatus === 401
          ? 'Payments need to be set up again. Send your request once more.'
          : error.code === 'unknown'
            ? 'Payments could not do that right now. Try again.'
            : error.message;
      return res.status(error.httpStatus >= 500 ? 502 : 409).json({ error: { message } });
    }
    if (error instanceof SyntaxError) return res.status(400).json({ error: { message: 'The request could not be read.' } });
    console.error('[demo] unexpected error:', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown');
    res.status(500).json({ error: { message: 'Something went wrong. Try again.' } });
  });

  return app;
}
