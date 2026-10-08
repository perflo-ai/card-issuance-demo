import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, wait, type FrameEventPayload } from './api';
import { CardDetails } from './CardDetails';
import { declineFallback, declineHint, money, when } from './copy';
import { PerfloFrame } from './PerfloFrame';
import { formatUsd } from '../../server/money';
import type { LinkStatus, Notice, OrderPhase, OrderView } from '../../server/views';

type Message = { id: string; kind: 'user' | 'assistant'; text: string } | { id: string; kind: 'order'; orderId: string };

interface ChatProps {
  perfloOrigin: string;
  onAccountChanged: () => void;
  onChangeLimits: () => void;
}

let nextId = 0;
const newId = () => `m${++nextId}`;

/** Phases that move on by themselves, and which we watch for a while. */
const SETTLED: ReadonlySet<OrderPhase> = new Set(['declined', 'completed', 'cancelled', 'expired', 'failed', 'discarded']);

export function Chat({ perfloOrigin, onAccountChanged, onChangeLimits }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [orders, setOrders] = useState<Record<string, OrderView>>({});
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .orders()
      .then(({ orders: list }) => {
        setOrders(Object.fromEntries(list.map((o) => [o.id, o])));
        setMessages(list.map((o) => ({ id: newId(), kind: 'order' as const, orderId: o.id })));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const put = useCallback((order: OrderView) => setOrders((all) => ({ ...all, [order.id]: order })), []);

  const advance = useCallback(
    async (id: string): Promise<OrderView | null> => {
      setBusy((b) => ({ ...b, [id]: true }));
      setErrors((e) => ({ ...e, [id]: '' }));
      try {
        const result = await api.advance(id);
        put(result.order);
        setNotices((n) => ({ ...n, [id]: result.notice }));
        onAccountChanged();
        return result.order;
      } catch (error) {
        setErrors((e) => ({ ...e, [id]: error instanceof Error ? error.message : 'Something went wrong.' }));
        return null;
      } finally {
        setBusy((b) => ({ ...b, [id]: false }));
      }
    },
    [put, onAccountChanged],
  );

  /**
   * Looks again until the order leaves `from`, for a bounded time. Retry is always a status read, never a new order.
   * Five minutes: a card can take a few minutes to be ready, and giving up sooner left a ready card showing as not ready.
   */
  const watch = useCallback(
    async (id: string, from: OrderPhase, tries = 100, delayMs = 3000) => {
      for (let i = 0; i < tries; i++) {
        const order = await advance(id);
        if (!order || order.phase !== from) return;
        await wait(delayMs);
      }
    },
    [advance],
  );

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setText('');
    setMessages((m) => [...m, { id: newId(), kind: 'user', text: value }]);
    try {
      const result = await api.chat(value);
      setMessages((m) => [...m, { id: newId(), kind: 'assistant', text: result.reply }]);
      if (result.order) {
        put(result.order);
        setMessages((m) => [...m, { id: newId(), kind: 'order', orderId: result.order!.id }]);
      }
    } catch (error) {
      setMessages((m) => [
        ...m,
        { id: newId(), kind: 'assistant', text: error instanceof Error ? error.message : 'Something went wrong.' },
      ]);
    } finally {
      setSending(false);
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
        {messages.map((m) =>
          m.kind === 'order' ? (
            orders[m.orderId] && orders[m.orderId].phase !== 'discarded' ? (
              <OrderCard
                key={m.id}
                order={orders[m.orderId]}
                notice={notices[m.orderId] ?? null}
                busy={!!busy[m.orderId]}
                error={errors[m.orderId] ?? ''}
                perfloOrigin={perfloOrigin}
                onAdvance={() => advance(m.orderId)}
                onWatch={(from, tries, delayMs) => watch(m.orderId, from, tries, delayMs)}
                onDiscard={async () => {
                  try {
                    put((await api.discard(m.orderId)).order);
                  } catch (error) {
                    setErrors((e) => ({ ...e, [m.orderId]: error instanceof Error ? error.message : 'Something went wrong.' }));
                  }
                }}
                onCancelCard={async (perfloOrderId) => {
                  setBusy((b) => ({ ...b, [m.orderId]: true }));
                  try {
                    const result = await api.cancelCard(perfloOrderId);
                    if (result.order) put(result.order);
                    onAccountChanged();
                  } catch (error) {
                    setErrors((e) => ({ ...e, [m.orderId]: error instanceof Error ? error.message : 'Something went wrong.' }));
                  } finally {
                    setBusy((b) => ({ ...b, [m.orderId]: false }));
                  }
                }}
                onChangeLimits={onChangeLimits}
                onAccountChanged={onAccountChanged}
              />
            ) : null
          ) : (
            <div key={m.id} className={`bubble ${m.kind}`}>
              {m.text}
            </div>
          ),
        )}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={send}>
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
        <button type="submit" aria-label="Send" disabled={sending || !text.trim()}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 14V4M4.5 8.5 9 4l4.5 4.5" />
          </svg>
        </button>
      </form>
    </section>
  );
}

interface CardProps {
  order: OrderView;
  notice: Notice;
  busy: boolean;
  error: string;
  perfloOrigin: string;
  onAdvance: () => Promise<OrderView | null>;
  onWatch: (from: OrderPhase, tries?: number, delayMs?: number) => Promise<void>;
  onDiscard: () => void;
  onCancelCard: (perfloOrderId: string) => void;
  onChangeLimits: () => void;
  onAccountChanged: () => void;
}

function OrderCard(props: CardProps) {
  const { order, notice, busy, error, perfloOrigin, onAdvance, onWatch } = props;
  const [frameOpen, setFrameOpen] = useState(false);
  const [linkProblem, setLinkProblem] = useState<'' | 'expired' | 'slow'>('');
  const [checkingIdentity, setCheckingIdentity] = useState(false);
  const amount = formatUsd(order.amountCents);
  const watching = useRef(false);

  // Card issuing finishes on its own: keep looking for a while.
  useEffect(() => {
    if (order.phase !== 'issuing' || watching.current) return;
    watching.current = true;
    onWatch('issuing').finally(() => {
      watching.current = false;
    });
  }, [order.phase, onWatch]);

  /**
   * The result can take a minute to reach the order after the person finishes the
   * check, so one look is not enough: keep looking for two minutes. Gently, because
   * while the check is still due each look asks for a fresh check link.
   */
  const checkIdentityDone = async () => {
    setCheckingIdentity(true);
    try {
      await onWatch('identity_check_required', 20, 6000);
    } finally {
      setCheckingIdentity(false);
    }
  };

  const afterSetup = async (link: LinkStatus | undefined) => {
    let status = link;
    // The sign-in can take a moment to show as approved; look a few more times.
    for (let i = 0; status === 'pending' && i < 8; i++) {
      await wait(1500);
      status = (await api.refreshLink().catch(() => ({ link: 'pending' as const }))).link;
    }
    if (status === 'expired') return setLinkProblem('expired');
    if (status !== 'linked') return setLinkProblem('slow');
    setFrameOpen(false);
    setLinkProblem('');
    props.onAccountChanged();
    if (order.phase === 'login_required') await onWatch('login_required');
    else await onAdvance();
  };

  const onFrameEvent = (event: FrameEventPayload, link: LinkStatus | undefined) => {
    if (event.type === 'perflo:closed') setFrameOpen(false);
    if (event.type === 'perflo:setup_completed') void afterSetup(link);
    if (event.type === 'perflo:top_up_completed') {
      if (!event.order_id || event.order_id === order.perfloOrderId) {
        setFrameOpen(false);
        props.onAccountChanged();
        void onWatch('payment_required');
      }
    }
  };

  const header = (
    <div className="order-head">
      <span className="order-amount">{amount}</span>
      <span className="order-merchant">{order.domain}</span>
      {order.description && <span className="order-desc">{order.description}</span>}
    </div>
  );

  let body: ReactNode = null;
  switch (order.phase) {
    case 'draft':
      body = (
        <>
          <p>Pay {amount} at {order.domain}?</p>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void onAdvance()}>
              Yes, go ahead
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
          <ol className="steps">
            <li>Verify it is you</li>
            <li>Allow Tiny to pay for you</li>
            <li>Add money if needed</li>
          </ol>
          {frameOpen && order.frameUrl ? (
            <PerfloFrame src={order.frameUrl} title="Set up payments" perfloOrigin={perfloOrigin} onEvent={onFrameEvent} />
          ) : (
            <button className="primary" disabled={busy} onClick={() => setFrameOpen(true)}>
              Set up payments
            </button>
          )}
          {linkProblem === 'expired' && (
            <div className="problem">
              <p>That setup link expired.</p>
              <button className="secondary" onClick={() => { setLinkProblem(''); setFrameOpen(false); void onAdvance(); }}>
                Start again
              </button>
            </div>
          )}
          {linkProblem === 'slow' && (
            <div className="problem">
              <p>Setup is taking longer than usual.</p>
              <button className="secondary" onClick={() => void afterSetup('pending')}>
                Check again
              </button>
            </div>
          )}
          {!frameOpen && <p className="muted small">About a minute. Only needed once.</p>}
        </>
      );
      break;
    case 'placing':
      body = (
        <>
          <p>Placing your order...</p>
          <button className="secondary" disabled={busy} onClick={() => void onAdvance()}>
            Check again
          </button>
        </>
      );
      break;
    case 'payment_required':
      body = (
        <>
          <p>
            Your balance does not cover this yet. Add {money(order.amountDue ?? '0.00')} and I will place the order right away.
          </p>
          {frameOpen && order.frameUrl ? (
            <PerfloFrame src={order.frameUrl} title="Add money" perfloOrigin={perfloOrigin} onEvent={onFrameEvent} />
          ) : (
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => setFrameOpen(true)}>
                Add {money(order.amountDue ?? '0.00')}
              </button>
              <button className="secondary" disabled={busy} onClick={() => void onAdvance()}>
                I already added money
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
                There is no check link right now. If you have already finished it, your order goes ahead as soon as the
                result is confirmed, usually within a minute.
              </p>
            )}
            <button className="secondary" disabled={busy || checkingIdentity} onClick={() => void checkIdentityDone()}>
              {checkingIdentity ? 'Checking...' : 'I have finished, try again'}
            </button>
          </div>
        </>
      );
      break;
    case 'issuing':
      body = (
        <>
          <p className="working">Getting your one-time card ready...</p>
          <button className="secondary" disabled={busy} onClick={() => void onAdvance()}>
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
          {order.perfloOrderId && (
            <button className="secondary" disabled={busy} onClick={() => props.onCancelCard(order.perfloOrderId as string)}>
              Cancel card
            </button>
          )}
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
          {notice === 'card_locked' && <p className="error">The card details could not be opened. Try again in a moment.</p>}
          {notice === 'reveal_failed' && <p className="error">I could not open the card details. Try again.</p>}
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void onAdvance()}>
              Use the card
            </button>
            {order.perfloOrderId && (
              <button className="secondary" disabled={busy} onClick={() => props.onCancelCard(order.perfloOrderId as string)}>
                Cancel card
              </button>
            )}
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
            {order.amountReturned && order.amountReturned !== '0.00'
              ? `${money(order.amountReturned)} went back to your balance.`
              : ''}
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
    <article className={`order-card ${SETTLED.has(order.phase) ? 'settled' : ''}`} aria-busy={busy}>
      {header}
      {body}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
