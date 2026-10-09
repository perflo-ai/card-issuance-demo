import { useCallback, useEffect, useRef, useState, type SubmitEvent, type ReactNode } from 'react';
import { api, type FrameEventPayload } from './api';
import { pageVisibility, useFocusWhenClosed } from './browser';
import { cancelUntilDone } from './cancel';
import { CardDetails } from './CardDetails';
import { CANCEL_SLOW_TEXT, declineFallback, declineHint, money, stalledText, stepLabel, waitingText, when, type Waiting } from './copy';
import { onLive } from './live';
import { PerfloFrame } from './PerfloFrame';
import { orderSteps, stepOf, type StepKey } from './progress';
import { SetupFlow } from './Setup';
import { StepList } from './Steps';
import { formatUsd } from '../../server/money';
import type { Notice, OrderPhase, OrderView } from '../../server/views';

type Message = { id: string; kind: 'user' | 'assistant'; text: string } | { id: string; kind: 'order'; orderId: string };

/** What the person is doing with an order right now. One at a time per order. */
type Action = 'place' | 'pay' | 'check' | 'cancel' | 'discard';

interface ChatProps {
  perfloOrigin: string;
  orders: Record<string, OrderView>;
  /** The steps each order has been seen on, from the statuses the server returned. */
  seen: Record<string, StepKey[]>;
  loaded: boolean;
  onOrder: (order: OrderView) => void;
  onAccountChanged: () => void;
  onChangeLimits: () => void;
  /** Payments were just set up (or turned back on) from an order in the chat. */
  onLinked: () => void;
}

let nextId = 0;
const newId = () => `m${++nextId}`;

const SETTLED: ReadonlySet<OrderPhase> = new Set(['declined', 'completed', 'cancelled', 'expired', 'failed', 'discarded']);

/**
 * How long Tiny waits for Perflo's word (a webhook) after the person did something, before saying it
 * is taking longer than usual. Nothing is asked in the meantime: the change is pushed when it happens.
 * A timer for the words on the page only, never a request.
 */
const STALL_MS: Record<Waiting, number> = {
  setup: 2 * 60_000,
  placing: 5 * 60_000,
  identity: 2 * 60_000,
  money: 5 * 60_000,
  card: 5 * 60_000,
};

export function Chat({ perfloOrigin, orders, seen, loaded, onOrder, onAccountChanged, onChangeLimits, onLinked }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const [actions, setActions] = useState<Record<string, Action | null>>({});
  const [waiting, setWaiting] = useState<Record<string, Waiting | null>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Orders whose cancel has not gone through yet after Tiny kept trying. */
  const [slowCancels, setSlowCancels] = useState<Record<string, boolean>>({});
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const inflight = useRef(new Map<string, Promise<OrderView | null>>());
  /** For each order Tiny is waiting on: the phase it was in when the wait began, and the stall timer. */
  const expecting = useRef(new Map<string, { from: OrderPhase; timer: ReturnType<typeof setTimeout> }>());
  const seeded = useRef(false);

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

  // Leaving the chat (signing out) clears every wait.
  useEffect(
    () => () => {
      for (const w of expecting.current.values()) clearTimeout(w.timer);
      expecting.current.clear();
    },
    [],
  );

  // A checkout notice that came with a pushed order (Tiny tried the card when Perflo said it was ready).
  useEffect(
    () =>
      onLive((message) => {
        if (message.type === 'order') setNotices((all) => ({ ...all, [message.order.id]: message.notice }));
      }),
    [],
  );

  // A wait ends when the order moves on, which Perflo's webhook tells Tiny's server and the page hears.
  useEffect(() => {
    for (const [id, wait] of expecting.current) {
      const order = orders[id];
      if (order && order.phase !== wait.from) {
        clearTimeout(wait.timer);
        expecting.current.delete(id);
        setWaiting((all) => ({ ...all, [id]: null }));
        setNotes((all) => ({ ...all, [id]: '' }));
      }
    }
  }, [orders]);

  const setFor = <T,>(set: (f: (all: Record<string, T>) => Record<string, T>) => void, id: string, value: T) =>
    set((all) => ({ ...all, [id]: value }));

  /**
   * One step forward for an order. A second call while one is on its way joins it, so a
   * double click never sends the same request twice.
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
   * The person did something Perflo answers later (paid, finished the ID check, signed in again):
   * show that Tiny is waiting, until the order moves on. If it has not after a while, say so calmly.
   */
  const expect = useCallback((id: string, from: OrderPhase, what: Waiting) => {
    const previous = expecting.current.get(id);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      if (expecting.current.get(id)?.timer !== timer) return;
      expecting.current.delete(id);
      setWaiting((all) => ({ ...all, [id]: null }));
      setNotes((all) => ({ ...all, [id]: stalledText(what) }));
    }, STALL_MS[what]);
    expecting.current.set(id, { from, timer });
    setWaiting((all) => ({ ...all, [id]: what }));
    setNotes((all) => ({ ...all, [id]: '' }));
  }, []);

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

  /** Stays on "Cancelling..." while payments is briefly busy, and keeps sending the cancel (safe to repeat). */
  const cancelCard = async (id: string, perfloOrderId: string) => {
    setFor(setActions, id, 'cancel');
    setFor(setErrors, id, '');
    setFor(setSlowCancels, id, false);
    try {
      const outcome = await cancelUntilDone(() => api.cancelCard(perfloOrderId), { visibility: pageVisibility });
      if (outcome.kind === 'slow') setFor(setSlowCancels, id, true);
      else if (outcome.cancelled.order) onOrder(outcome.cancelled.order);
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
              cancelSlow={slowCancels[m.orderId] ?? false}
              perfloOrigin={perfloOrigin}
              onAdvance={(action) => advance(m.orderId, action)}
              onExpect={(from, what) => expect(m.orderId, from, what)}
              onDiscard={() => void discard(m.orderId)}
              onCancelCard={(perfloOrderId) => void cancelCard(m.orderId, perfloOrderId)}
              onChangeLimits={onChangeLimits}
              onAccountChanged={onAccountChanged}
              onLinked={onLinked}
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
  /** The cancel has not gone through yet after Tiny kept trying: say so calmly and offer to check again. */
  cancelSlow: boolean;
  perfloOrigin: string;
  onAdvance: (action: Action) => Promise<OrderView | null>;
  /** Show that Tiny is waiting for Perflo's word on this order, until it moves on. */
  onExpect: (from: OrderPhase, what: Waiting) => void;
  onDiscard: () => void;
  onCancelCard: (perfloOrderId: string) => void;
  onChangeLimits: () => void;
  onAccountChanged: () => void;
  onLinked: () => void;
}

export function OrderCard(props: CardProps) {
  const { order, action, waiting, note, error, perfloOrigin, onAdvance, onExpect } = props;
  const [frameOpen, setFrameOpen] = useState(false);
  const card = useRef<HTMLElement>(null);
  useFocusWhenClosed(frameOpen, card);
  const amount = formatUsd(order.amountCents);
  const busy = action !== null;

  // A card being made finishes on its own, and Perflo says so: wait for it without asking.
  const expectLatest = useRef(onExpect);
  expectLatest.current = onExpect;
  useEffect(() => {
    if (order.phase === 'issuing') expectLatest.current('issuing', 'card');
  }, [order.phase]);

  const onFrameEvent = (event: FrameEventPayload) => {
    if (event.type === 'perflo:closed') setFrameOpen(false);
    if (event.type === 'perflo:top_up_completed' && (!event.order_id || event.order_id === order.perfloOrderId)) {
      setFrameOpen(false);
      props.onAccountChanged();
      onExpect('payment_required', 'money');
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

  const cancelSlow = props.cancelSlow && action !== 'cancel';
  const cancelButton = (className: string) =>
    order.perfloOrderId && (
      <button className={className} disabled={busy} onClick={() => props.onCancelCard(order.perfloOrderId as string)}>
        {action === 'cancel' ? 'Cancelling...' : cancelSlow ? 'Check again' : 'Cancel card'}
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
              props.onLinked();
              props.onAccountChanged();
              if (order.phase === 'login_required') {
                onExpect('login_required', 'placing');
                // One look now: the order may already have gone ahead while the frame was closing.
                await onAdvance('check');
              } else await onAdvance('place');
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
              onClick={() => {
                onExpect('identity_check_required', 'identity');
                void onAdvance('check');
              }}
            >
              {waiting === 'identity' || action === 'check' ? 'Checking...' : 'I have finished, try again'}
            </button>
          </div>
        </>
      );
      break;
    case 'issuing':
      body = (
        <>
          {!waiting && <p>{waitingText('card')}</p>}
          <button className="secondary" disabled={busy} onClick={() => void onAdvance('check')}>
            {action === 'check' ? 'Checking...' : 'Check again'}
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
      {cancelSlow && order.phase === 'ready' && (
        <p className="muted small" role="status">
          {CANCEL_SLOW_TEXT}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
