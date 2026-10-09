import { useEffect, useMemo, useRef, useState } from 'react';
import { api, onRequestSettled } from './api';
import { useOnMount, useWhenVisible } from './browser';
import { identityText, money, when } from './copy';
import { Orders } from './Orders';
import { PerfloFrame } from './PerfloFrame';
import { singleFlight } from './polling';
import type { AccountView, LogEntry, MeView, OrderView } from '../../server/views';

interface Props {
  perfloOrigin: string;
  mode: 'live' | 'mock';
  /** Bumped by the chat whenever money or access may have changed. */
  refreshKey: number;
  /** Bumped when the chat asks to change limits. */
  limitsRequest: number;
  onAccountChanged: () => void;
  /** The person's orders, shared with the chat; null until the first list arrives. */
  orders: OrderView[] | null;
  ordersError: string;
  onRefreshOrders: () => Promise<void>;
  onOrder: (order: OrderView) => void;
  me: MeView;
  onMe: (me: MeView) => void;
}

type OpenFrame = { kind: 'limits' | 'top_up'; url: string } | null;
type Tab = 'payments' | 'orders';
/** What the payments box is doing right now; one thing at a time. */
type Busy = 'top_up' | 'limits' | 'revoke' | { cancel: string } | null;

export function Panel(props: Props) {
  const { perfloOrigin, mode, refreshKey, limitsRequest, onAccountChanged, me, onMe } = props;
  const [account, setAccount] = useState<AccountView | null>(null);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [frame, setFrame] = useState<OpenFrame>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [savingStop, setSavingStop] = useState(false);
  const [tab, setTab] = useState<Tab>('payments');

  /**
   * The balance is read when it can have changed: on opening, after an order changes phase or a
   * card is cancelled, after money or limits are saved in a frame, and when the page comes back
   * into view. There is nothing to wait for in between, so there is no timer. A read asked for
   * while one is on its way runs once more after it, never at the same time.
   */
  const loadAccount = useMemo(
    () =>
      singleFlight(async () => {
        try {
          const result = await api.account();
          setLinked(result.linked);
          setAccount(result.linked ? result.account : null);
          setError('');
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not load your balance.');
        }
      }),
    [],
  );
  const loadedFor = useRef<number | null>(null);
  useEffect(() => {
    if (loadedFor.current === refreshKey) return;
    loadedFor.current = refreshKey;
    void loadAccount();
  }, [refreshKey, loadAccount]);
  useWhenVisible(() => void loadAccount());

  const openLimits = async () => {
    setError('');
    setBusy('limits');
    try {
      setFrame({ kind: 'limits', url: (await api.limitsLink()).frameUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const lastLimitsRequest = useRef(limitsRequest);
  useEffect(() => {
    if (limitsRequest === lastLimitsRequest.current) return;
    lastLimitsRequest.current = limitsRequest;
    if (linked) void openLimits();
  }, [limitsRequest, linked]);

  const openTopUp = async () => {
    setError('');
    setBusy('top_up');
    try {
      setFrame({ kind: 'top_up', url: (await api.topUp()).frameUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const cancelCard = async (perfloOrderId: string) => {
    setError('');
    setBusy({ cancel: perfloOrderId });
    try {
      const result = await api.cancelCard(perfloOrderId);
      // The chat and the Orders tab show the same order: one update reaches both.
      if (result.order) props.onOrder(result.order);
      else onAccountChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    setError('');
    setBusy('revoke');
    try {
      await api.mockRevoke();
      onAccountChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const setStopAtCheckout = async (on: boolean) => {
    setError('');
    setSavingStop(true);
    try {
      onMe((await api.mockStopAtCheckout(on)).user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setSavingStop(false);
    }
  };

  const cancellingCard = typeof busy === 'object' && busy !== null ? busy.cancel : null;

  return (
    <aside className="panel" aria-label="Payments and orders">
      <div className="tabs" role="tablist" aria-label="Payments and orders">
        {(['payments', 'orders'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            id={`tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`tabpanel-${t}`}
            className={tab === t ? 'tab active' : 'tab'}
            onClick={() => setTab(t)}
          >
            {t === 'payments' ? 'Payments' : 'Orders'}
          </button>
        ))}
      </div>

      {tab === 'orders' && (
        <div role="tabpanel" id="tabpanel-orders" aria-labelledby="tab-orders">
          <Orders
            orders={props.orders}
            error={props.ordersError}
            onRefresh={props.onRefreshOrders}
            onOrder={props.onOrder}
            onAccountChanged={onAccountChanged}
          />
        </div>
      )}

      <section className="box" role="tabpanel" id="tabpanel-payments" aria-labelledby="tab-payments" hidden={tab !== 'payments'}>
        <h2>Payments</h2>
        {linked === null && <p className="muted">Loading...</p>}
        {linked === false && (
          <p className="muted">Not set up yet. Tiny asks you to set up payments the first time it buys something for you.</p>
        )}
        {account && (
          <>
            <p className="balance">
              {money(account.balance.amount)}
              <span className="muted small"> balance</span>
            </p>
            <dl className="facts">
              <dt>Per order, up to</dt>
              <dd>{money(account.limits.per_order.amount)}</dd>
              <dt>Per month, up to</dt>
              <dd>{money(account.limits.per_month.amount)}</dd>
              <dt>Used this month</dt>
              <dd>{money(account.limits.spent_this_month.amount)}</dd>
              <dt>Left this month</dt>
              <dd>{money(account.limits.remaining_this_month.amount)}</dd>
              <dt>Identity check</dt>
              <dd>{identityText(account.identity_check.status, account.identity_check.required_above)}</dd>
            </dl>
            <div className="row">
              <button className="secondary" disabled={busy !== null} onClick={() => void openTopUp()}>
                {busy === 'top_up' ? 'Opening...' : 'Add money'}
              </button>
              <button className="secondary" disabled={busy !== null} onClick={() => void openLimits()}>
                {busy === 'limits' ? 'Opening...' : 'Change limits'}
              </button>
            </div>
            {account.open_cards.length > 0 && (
              <>
                <h3>Open cards</h3>
                <ul className="cards">
                  {account.open_cards.map((card) => (
                    <li key={card.order_id}>
                      <span>
                        .... {card.last4} · up to {money(card.card_limit)}
                        <span className="muted small"> · until {when(card.expires_at)}</span>
                      </span>
                      <button className="link" disabled={busy !== null} onClick={() => void cancelCard(card.order_id)}>
                        {cancellingCard === card.order_id ? 'Cancelling...' : 'Cancel card'}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        {frame && (
          <div className="panel-frame">
            <PerfloFrame
              src={frame.url}
              title={frame.kind === 'limits' ? 'Change limits' : 'Add money'}
              perfloOrigin={perfloOrigin}
              onEvent={(event) => {
                if (event.type === 'perflo:closed') setFrame(null);
                if (event.type === 'perflo:limits_saved' || event.type === 'perflo:top_up_completed') {
                  onAccountChanged();
                }
              }}
            />
            <button className="link" onClick={() => setFrame(null)}>
              Close
            </button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      {mode === 'mock' && (
        <section className="box">
          <h2>Test controls</h2>
          <p className="muted small">Only in test mode.</p>
          <label className="check">
            <input
              type="checkbox"
              checked={me.stopAtCheckout}
              disabled={savingStop}
              onChange={(e) => void setStopAtCheckout(e.target.checked)}
            />
            Stop at the checkout page without buying, so the card stays open and can be cancelled
          </label>
          {linked && (
            <>
              <p className="muted small">
                Acts as if you turned off Tiny&apos;s access yourself, so the next order asks you to sign in again.
              </p>
              <button className="secondary" disabled={busy !== null} onClick={() => void revoke()}>
                {busy === 'revoke' ? 'Turning off...' : "Turn off Tiny's access"}
              </button>
            </>
          )}
        </section>
      )}

      <DeveloperLog />
    </aside>
  );
}

/**
 * Every line here is written while Tiny's server answers one of this page's
 * requests, so the log reads new lines when such a request finishes (and when
 * the page comes back into view), never on a timer: nothing new can appear
 * while the page is quiet.
 */
function DeveloperLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState('');
  const last = useRef(0);

  const load = useMemo(
    () =>
      singleFlight(async () => {
        try {
          const { events } = await api.events(last.current);
          setError('');
          const newest = events.at(-1);
          if (!newest) return;
          last.current = newest.id;
          setEntries((all) => [...all, ...events].slice(-200));
        } catch {
          setError('The log could not be read. It catches up after your next action.');
        }
      }),
    [],
  );
  useOnMount(() => void load());
  useEffect(() => onRequestSettled(() => void load()), [load]);
  useWhenVisible(() => void load());

  return (
    <section className="box log" aria-label="Developer log">
      <h2>Developer log</h2>
      <p className="muted small">
        What Tiny&apos;s server sent and received, one line per change: a status read again with the same answer is not repeated. Access
        tokens, card details and link codes are removed.
      </p>
      {error && <p className="error">{error}</p>}
      <ol>
        {[...entries].reverse().map((entry) => (
          <li key={entry.id}>
            <details>
              <summary>
                <span className={`tag ${entry.kind}`}>{entry.kind}</span> {entry.summary}
                <time className="muted small"> {new Date(entry.at).toLocaleTimeString()}</time>
              </summary>
              {entry.detail !== undefined && <pre>{JSON.stringify(entry.detail, null, 2)}</pre>}
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
