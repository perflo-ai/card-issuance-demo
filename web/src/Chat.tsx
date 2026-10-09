import { useCallback, useEffect, useRef, useState, type SubmitEvent, type ReactNode } from 'react';
import { api, type FrameEventPayload } from './api';
import { pageVisibility, useFocusWhenClosed, useOnMount } from './browser';
import { CardDetails } from './CardDetails';
import { declineFallback, declineHint, money, stalledText, stepLabel, waitingText, when, type Waiting } from './copy';
import { PerfloFrame } from './PerfloFrame';
import { backoff, poll } from './polling';
import { orderSteps, stepOf, type StepKey } from './progress';
import { SetupFlow } from './Setup';
import { StepList } from './Steps';
import { formatUsd } from '../../server/money';
import type { Notice, OrderPhase, OrderView } from '../../server/views';

type Message = { id: string; kind: 'user' | 'assistant'; text: string } | { id: string; kind: 'order'; orderId: string };

/** What the person (or Tiny, for 'watch') is doing with an order right now. One at a time per order. */
type Action = 'place' | 'pay' | 'check' | 'cancel' | 'discard' | 'watch';

interface ChatProps {
  perfloOrigin: string;
  orders: Record<string, OrderView>;
  /** The steps each order has been seen on, from the statuses the server returned. */
  seen: Record<string, StepKey[]>;
  loaded: boolean;
  onOrder: (order: OrderView) => void;
  onAccountChanged: () => void;
  onChangeLimits: () => void;
  /** Just connected: put the cursor in the message box, the next thing to use. */
  focusComposer?: boolean;
}

let nextId = 0;
const newId = () => `m${++nextId}`;

const SETTLED: ReadonlySet<OrderPhase> = new Set(['declined', 'completed', 'cancelled', 'expired', 'failed', 'discarded']);

/**
 * How Tiny keeps looking at an order that is waiting on the payments side. Each look is a status read
 * (never a new order) and starts only after the previous one finished. Identity checks are looked at
 * gently, because while one is still due each look asks payments for a fresh check link.
 */
const WATCH: Partial<Record<OrderPhase, { waiting: Waiting; delay: (attempt: number) => number; budgetMs: number }>> = {
  // A card can take a few minutes to be ready; giving up sooner left a ready card showing as not ready.
  issuing: { waiting: 'card', delay: backoff(2000, 10_000), budgetMs: 5 * 60_000 },
  payment_required: { waiting: 'money', delay: backoff(2000, 10_000), budgetMs: 5 * 60_000 },
  login_required: { waiting: 'placing', delay: backoff(2000, 10_000), budgetMs: 5 * 60_000 },
  identity_check_required: { waiting: 'identity', delay: backoff(6000, 15_000), budgetMs: 2 * 60_000 },
};

interface Watch {
  from: OrderPhase;
  stop: AbortController;
  done: Promise<void>;
}

export function Chat({ perfloOrigin, orders, seen, loaded, onOrder, onAccountChanged, onChangeLimits, focusComposer = false }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const [actions, setActions] = useState<Record<string, Action | null>>({});
  const [waiting, setWaiting] = useState<Record<string, Waiting | null>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const inflight = useRef(new Map<string, Promise<OrderView | null>>());
  const watches = useRef(new Map<string, Watch>());
  const seeded = useRef(false);
  const composer = useRef<HTMLInputElement>(null);
  useOnMount(() => {
    if (focusComposer) composer.current?.focus();
  });

  // The orders already made appear in the chat once, when the list first arrives.
  useEffect(() => {
    if (!loaded || seeded.current) return;
    seeded.current = true;
    setMessages((current) => {
      const shown = new Set(current.flatMap((m) => (m.kind === 'order' ? [m.orderId] : [])));
      const earlier = Object.keys(orders)
        .filter((id) => !shown.has(id))
        .map((orderId) => ({ id: newId(), kind: 'order' as const, orderId }));
      return [...earlier, ...current];
    });
  }, [loaded, orders]);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  // Leaving the chat (signing out) stops every watch.
  useEffect(
    () => () => {
      for (const w of watches.current.values()) w.stop.abort();
      watches.current.clear();
    },
    [],
  );

  const setFor = <T,>(set: (f: (all: Record<string, T>) => Record<string, T>) => void, id: string, value: T) =>
    set((all) => ({ ...all, [id]: value }));

  /**
   * One step forward for an order. A second call while one is on its way joins it, so a
   * double click or a watch look never sends the same request twice.
   */
  const advance = useCallback(
    (id: string, action: Action): Promise<OrderView | null> => {
      const running = inflight.current.get(id);
      if (running) return running;
      const run = (async () => {
        setFor(setActions, id, action);
        setFor(setErrors, id, '');
        try {
          const result = await api.advance(id);
          onOrder(result.order);
          setFor(setNotices, id, result.notice);
          return result.order;
        } catch (error) {
          setFor(setErrors, id, error instanceof Error ? error.message : 'Something went wrong. Try again.');
          return null;
        } finally {
          inflight.current.delete(id);
          setFor(setActions, id, null);
        }
      })();
      inflight.current.set(id, run);
      return run;
    },
    [onOrder],
  );

  /**
   * Keeps looking at an order until it leaves `from`, for a bounded time. One watch per order:
   * asking again for the same wait joins it; `restart` looks again now. A new watch waits for
   * the old one to stop, so looks never overlap.
   */
  const watch = useCallback(
    (id: string, from: OrderPhase, restart = false): Promise<void> => {
      const previous = watches.current.get(id);
      if (previous && previous.from === from && !restart) return previous.done;
      const plan = WATCH[from];
      if (!plan) return Promise.resolve();
      const stop = new AbortController();
      const done = (async () => {
        if (previous) {
          previous.stop.abort();
          await previous.done;
        }
        if (stop.signal.aborted) return;
        setFor(setWaiting, id, plan.waiting);
        setFor(setNotes, id, '');
        try {
          const result = await poll({
            look: () => advance(id, 'watch'),
            settled: (order) => !order || order.phase !== from,
            delay: plan.delay,
            budgetMs: plan.budgetMs,
            signal: stop.signal,
            visibility: pageVisibility,
          });
          if (result === 'gave_up') setFor(setNotes, id, stalledText(plan.waiting));
        } finally {
          if (watches.current.get(id)?.stop === stop) {
            watches.current.delete(id);
            setFor(setWaiting, id, null);
          }
        }
      })();
      watches.current.set(id, { from, stop, done });
      return done;
    },
    [advance],
  );

  const stopWatching = async (id: string) => {
    const current = watches.current.get(id);
    if (!current) return;
    watches.current.delete(id);
    current.stop.abort();
    setFor(setWaiting, id, null);
    await current.done;
  };

  const send = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setText('');
    setMessages((m) => [...m, { id: newId(), kind: 'user', text: value }]);
    try {
      const result = await api.chat(value);
      setMessages((m) => [...m, { id: newId(), kind: 'assistant', text: result.reply }]);
      const order = result.order;
      if (order) {
        onOrder(order);
        setMessages((m) => [...m, { id: newId(), kind: 'order', orderId: order.id }]);
      }
    } catch (error) {
      setMessages((m) => [
        ...m,
        { id: newId(), kind: 'assistant', text: error instanceof Error ? error.message : 'Something went wrong. Try again.' },
      ]);
    } finally {
      setSending(false);
    }
  };

  const discard = async (id: string) => {
    setFor(setActions, id, 'discard');
    try {
      onOrder((await api.discard(id)).order);
    } catch (error) {
      setFor(setErrors, id, error instanceof Error ? error.message : 'Something went wrong. Try again.');
    } finally {
      setFor(setActions, id, null);
    }
  };

  const cancelCard = async (id: string, perfloOrderId: string) => {
    await stopWatching(id);
    setFor(setActions, id, 'cancel');
    setFor(setErrors, id, '');
    try {
      const result = await api.cancelCard(perfloOrderId);
      if (result.order) onOrder(result.order);
      else onAccountChanged();
    } catch (error) {
      setFor(setErrors, id, error instanceof Error ? error.message : 'Something went wrong. Try again.');
    } finally {
      setFor(setActions, id, null);
    }
  };

  return (
    <section className="chat" aria-label="Chat with Tiny">
      <div className="messages">
        {messages.length === 0 && (
          <div className="bubble assistant">
            Hi. Tell me what to buy and I will handle the checkout. For example: buy me $50 worth of headphones on amazon.
          </div>
        )}
        {messages.map((m) => {
          if (m.kind !== 'order') {
            return (
              <div key={m.id} className={`bubble ${m.kind}`}>
                {m.text}
              </div>
            );
          }
          const order = orders[m.orderId];
          return order && order.phase !== 'discarded' ? (
            <OrderCard
              key={m.id}
              order={order}
              seen={seen[m.orderId] ?? []}
              notice={notices[m.orderId] ?? null}
              action={actions[m.orderId] ?? null}
              waiting={waiting[m.orderId] ?? null}
              note={notes[m.orderId] ?? ''}
              error={errors[m.orderId] ?? ''}
              perfloOrigin={perfloOrigin}
              onAdvance={(action) => advance(m.orderId, action)}
              onWatch={(from, restart) => watch(m.orderId, from, restart)}
              onDiscard={() => void discard(m.orderId)}
              onCancelCard={(perfloOrderId) => void cancelCard(m.orderId, perfloOrderId)}
              onChangeLimits={onChangeLimits}
              onAccountChanged={onAccountChanged}
            />
          ) : null;
        })}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(event) => void send(event)}>
        <label htmlFor="msg" className="visually-hidden">
          Message Tiny
        </label>
        <input
          ref={composer}
          id="msg"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message Tiny"
          autoComplete="off"
          maxLength={500}
        />
        <button type="submit" aria-label={sending ? 'Sending' : 'Send'} disabled={sending || !text.trim()}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 14V4M4.5 8.5 9 4l4.5 4.5" />
          </svg>
        </button>
      </form>
    </section>
  );
}

interface CardProps {
  order: OrderView;
  seen: StepKey[];
  notice: Notice;
  action: Action | null;
  waiting: Waiting | null;
  note: string;
  error: string;
  perfloOrigin: string;
  onAdvance: (action: Action) => Promise<OrderView | null>;
  onWatch: (from: OrderPhase, restart?: boolean) => Promise<void>;
  onDiscard: () => void;
  onCancelCard: (perfloOrderId: string) => void;
  onChangeLimits: () => void;
  onAccountChanged: () => void;
}

export function OrderCard(props: CardProps) {
  const { order, action, waiting, note, error, perfloOrigin, onAdvance, onWatch } = props;
  const [frameOpen, setFrameOpen] = useState(false);
  const card = useRef<HTMLElement>(null);
  useFocusWhenClosed(frameOpen, card);
  const amount = formatUsd(order.amountCents);
  const busy = action !== null;

  // A card being made finishes on its own: keep looking while it does. Only when the phase changes:
  // after a watch gave up, it starts again only when the person asks.
  const watchLatest = useRef(onWatch);
  watchLatest.current = onWatch;
  useEffect(() => {
    if (order.phase === 'issuing') void watchLatest.current('issuing');
  }, [order.phase]);

  const onFrameEvent = (event: FrameEventPayload) => {
    if (event.type === 'perflo:closed') setFrameOpen(false);
    if (event.type === 'perflo:top_up_completed' && (!event.order_id || event.order_id === order.perfloOrderId)) {
      setFrameOpen(false);
      props.onAccountChanged();
      void onWatch('payment_required', true);
    }
  };

  const header = (
    <div className="order-head">
      <span className="order-amount">{amount}</span>
      <span className="order-merchant">{order.domain}</span>
      {order.description && <span className="order-desc">{order.description}</span>}
    </div>
  );

  // The order's steps, while it is on its way. Setup has its own list (the frame's steps).
  const current = stepOf(order.phase);
  const showSteps =
    current !== null && current !== 'setup' && !(order.phase === 'ready' && order.checkout && order.checkout.outcome !== 'charge_refused');
  const steps = showSteps
    ? orderSteps(current, new Set(props.seen)).map((s) => ({ label: stepLabel(s.key, order.domain), state: s.state }))
    : null;

  const cancelButton = (className: string) =>
    order.perfloOrderId && (
      <button className={className} disabled={busy} onClick={() => props.onCancelCard(order.perfloOrderId as string)}>
        {action === 'cancel' ? 'Cancelling...' : 'Cancel card'}
      </button>
    );

  let body: ReactNode = null;
  switch (order.phase) {
    case 'draft':
      body = (
        <>
          <p>
            Pay {amount} at {order.domain}?
          </p>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void onAdvance('place')}>
              {action === 'place' ? 'Placing your order...' : 'Yes, go ahead'}
            </button>
            <button className="secondary" disabled={busy} onClick={props.onDiscard}>
              Not now
            </button>
          </div>
        </>
      );
      break;
    case 'needs_setup':
    case 'login_required':
      body = (
        <>
          <h3>{order.phase === 'needs_setup' ? 'Set up payments for Tiny' : 'Turn Tiny payments back on'}</h3>
          {order.phase === 'needs_setup' ? (
            <p className="muted">I need you to set up payments once. After that I can pay for things like this without stopping to ask.</p>
          ) : (
            <p className="muted">Payments for Tiny were turned off. Sign in again to allow this order.</p>
          )}
          <SetupFlow
            perfloOrigin={perfloOrigin}
            disabled={busy}
            open={() => Promise.resolve(order.frameUrl ?? null)}
            onLinked={async () => {
              props.onAccountChanged();
              if (order.phase === 'login_required') await onWatch('login_required', true);
              else await onAdvance('place');
            }}
            onExpired={() => void onAdvance('check')}
          />
          {action === 'place' && (
            <p className="working" role="status">
              {waitingText('placing')}
            </p>
          )}
        </>
      );
      break;
    case 'placing':
      body = (
        <>
          <p>{waitingText('placing')}</p>
          <button className="secondary" disabled={busy} onClick={() => void onAdvance('check')}>
            {action === 'check' ? 'Checking...' : 'Check again'}
          </button>
        </>
      );
      break;
    case 'payment_required':
      body = (
        <>
          <p>Your balance does not cover this yet. Add {money(order.amountDue ?? '0.00')} and I will place the order right away.</p>
          {frameOpen && order.frameUrl ? (
            <PerfloFrame src={order.frameUrl} title="Add money" perfloOrigin={perfloOrigin} onEvent={onFrameEvent} />
          ) : (
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => setFrameOpen(true)}>
                Add {money(order.amountDue ?? '0.00')}
              </button>
              <button className="secondary" disabled={busy} onClick={() => void onAdvance('check')}>
                {action === 'check' ? 'Checking...' : 'I already added money'}
              </button>
            </div>
          )}
        </>
      );
      break;
    case 'identity_check_required':
      body = (
        <>
          <p>A quick identity check is needed before Tiny can pay for this. It only happens once.</p>
          <div className="row">
            {order.kycUrl ? (
              <a className="button primary" href={order.kycUrl} target="_blank" rel="noopener noreferrer">
                Verify your identity
              </a>
            ) : (
              <p className="muted small">
                There is no check link right now. If you have already finished it, your order goes ahead as soon as the result is confirmed,
                usually within a minute.
              </p>
            )}
            <button
              className="secondary"
              disabled={busy || waiting === 'identity'}
              onClick={() => void onWatch('identity_check_required', true)}
            >
              {waiting === 'identity' ? 'Checking...' : 'I have finished, try again'}
            </button>
          </div>
        </>
      );
      break;
    case 'issuing':
      body = (
        <>
          {!waiting && <p>{waitingText('card')}</p>}
          <button className="secondary" disabled={busy} onClick={() => void onWatch('issuing', true)}>
            Check again
          </button>
        </>
      );
      break;
    case 'ready':
      body = order.checkout ? (
        <>
          {order.perfloOrderId && (
            <CardDetails
              perfloOrderId={order.perfloOrderId}
              last4={order.checkout.last4}
              cardLimit={order.checkout.cardLimit}
              expMonth={order.checkout.expMonth}
              expYear={order.checkout.expYear}
            />
          )}
          {order.checkout.outcome === 'filled_not_submitted' && (
            <p>
              I filled in the checkout on {order.domain}. This demo stops before buying, so the card stays open until you cancel it
              {order.cardExpiresAt ? ` or it expires (${when(order.cardExpiresAt)})` : ''}. Unused money goes back to your balance.
            </p>
          )}
          {order.checkout.outcome === 'charge_refused' && <p>The shop did not accept the card. You can cancel it to get the money back.</p>}
          {cancelButton('secondary')}
        </>
      ) : (
        <>
          <p>
            Your one-time card <strong>.... {order.cardLast4}</strong> is ready
            {order.cardLimit ? `, up to ${money(order.cardLimit)}` : ''}.
          </p>
          {order.perfloOrderId && order.cardLast4 && (
            <CardDetails perfloOrderId={order.perfloOrderId} last4={order.cardLast4} cardLimit={order.cardLimit} />
          )}
          {props.notice === 'card_locked' && (
            <p className="error" role="alert">
              The card details could not be opened. Try again in a moment.
            </p>
          )}
          {props.notice === 'reveal_failed' && (
            <p className="error" role="alert">
              I could not open the card details. Try again.
            </p>
          )}
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void onAdvance('pay')}>
              {action === 'pay' ? `Paying at ${order.domain}...` : 'Use the card'}
            </button>
            {cancelButton('secondary')}
          </div>
        </>
      );
      break;
    case 'completed':
      body = (
        <>
          <p className="done">
            Paid {money(order.amountSpent ?? '0.00')} at {order.domain}.
          </p>
          <p className="muted small">
            {order.checkout ? `One-time card .... ${order.checkout.last4} is now closed. ` : ''}
            {order.amountReturned && order.amountReturned !== '0.00' ? `${money(order.amountReturned)} went back to your balance.` : ''}
          </p>
        </>
      );
      break;
    case 'declined':
      body = (
        <>
          <p>{order.declineMessage || (order.declineReason ? declineFallback(order.declineReason) : 'This order was not accepted.')}</p>
          {order.declineReason && declineHint(order.declineReason) && <p className="muted small">{declineHint(order.declineReason)}</p>}
          {(order.declineReason === 'over_order_limit' || order.declineReason === 'over_monthly_limit') && (
            <button className="secondary" onClick={props.onChangeLimits}>
              Change limits
            </button>
          )}
        </>
      );
      break;
    case 'cancelled':
      body = (
        <p>
          Cancelled.{' '}
          {order.amountReturned && order.amountReturned !== '0.00'
            ? `${money(order.amountReturned)} went back to your balance.`
            : 'Nothing was spent.'}
        </p>
      );
      break;
    case 'expired':
      body = <p>The card expired before it was used. The money went back to your balance.</p>;
      break;
    case 'failed':
      body = <p>This order could not be completed. Any money set aside for it goes back to your balance.</p>;
      break;
    case 'discarded':
      body = null;
      break;
  }

  return (
    <article
      ref={card}
      tabIndex={-1}
      className={`order-card ${SETTLED.has(order.phase) ? 'settled' : ''}`}
      aria-busy={busy || waiting !== null}
    >
      {header}
      {steps && <StepList items={steps} active={busy || waiting !== null} />}
      {body}
      {waiting && (
        <p className="working" role="status">
          {waitingText(waiting)}
        </p>
      )}
      {note && !waiting && <p className="muted small">{note}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
