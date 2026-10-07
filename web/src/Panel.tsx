import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { identityText, money, when } from './copy';
import { PerfloFrame } from './PerfloFrame';
import type { AccountView, LogEntry, MeView } from '../../server/views';

interface Props {
  perfloOrigin: string;
  mode: 'live' | 'mock';
  /** Bumped by the chat whenever money or access may have changed. */
  refreshKey: number;
  /** Bumped when the chat asks to change limits. */
  limitsRequest: number;
  onAccountChanged: () => void;
  me: MeView;
  onMe: (me: MeView) => void;
}

type OpenFrame = { kind: 'limits' | 'top_up'; url: string } | null;

export function Panel({ perfloOrigin, mode, refreshKey, limitsRequest, onAccountChanged, me, onMe }: Props) {
  const [account, setAccount] = useState<AccountView | null>(null);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [frame, setFrame] = useState<OpenFrame>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .account()
        .then((result) => {
          if (!live) return;
          setLinked(result.linked);
          setAccount(result.linked ? result.account : null);
        })
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'Could not load your balance.'));
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [refreshKey]);

  const openLimits = async () => {
    setError('');
    setBusy(true);
    try {
      setFrame({ kind: 'limits', url: (await api.limitsLink()).frameUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
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
    setBusy(true);
    try {
      setFrame({ kind: 'top_up', url: (await api.topUp()).frameUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const cancelCard = async (orderId: string) => {
    setError('');
    setBusy(true);
    try {
      await api.cancelCard(orderId);
      onAccountChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setError('');
    try {
      await api.mockRevoke();
      onAccountChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  return (
    <aside className="panel" aria-label="Payments">
      <section className="box">
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
              <dd>{money(account.limits.per_order)}</dd>
              <dt>Per month, up to</dt>
              <dd>{money(account.limits.per_month)}</dd>
              <dt>Used this month</dt>
              <dd>{money(account.limits.spent_this_month)}</dd>
              <dt>Left this month</dt>
              <dd>{money(account.limits.remaining_this_month)}</dd>
              <dt>Identity check</dt>
              <dd>{identityText(account.identity_check.status, account.identity_check.required_above)}</dd>
            </dl>
            <div className="row">
              <button className="secondary" disabled={busy} onClick={() => void openTopUp()}>
                Add money
              </button>
              <button className="secondary" disabled={busy} onClick={() => void openLimits()}>
                Change limits
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
                      <button className="link" disabled={busy} onClick={() => void cancelCard(card.order_id)}>
                        Cancel card
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
              onChange={(e) => {
                api
                  .mockStopAtCheckout(e.target.checked)
                  .then((r) => onMe(r.user))
                  .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Something went wrong.'));
              }}
            />
            Stop at the checkout page without buying, so the card stays open and can be cancelled
          </label>
          {linked && (
            <>
              <p className="muted small">Acts as if you turned off Tiny&apos;s access yourself, so the next order asks you to sign in again.</p>
              <button className="secondary" onClick={() => void revoke()}>
                Turn off Tiny&apos;s access
              </button>
            </>
          )}
        </section>
      )}

      <DeveloperLog />
    </aside>
  );
}

function DeveloperLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const last = useRef(0);

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .events(last.current)
        .then(({ events }) => {
          if (!live || events.length === 0) return;
          last.current = events[events.length - 1].id;
          setEntries((all) => [...all, ...events].slice(-200));
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="box log" aria-label="Developer log">
      <h2>Developer log</h2>
      <p className="muted small">What Tiny&apos;s server sent and received. Access tokens, card details and link codes are removed.</p>
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
