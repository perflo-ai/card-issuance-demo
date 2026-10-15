import { useEffect, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { api } from './api';
import { PAYMENT_TAB_TEXT, pageExpiredText } from './copy';
import { browserTabs } from './browser';
import { openPaymentTab, watchPaymentTab, type PaymentLink, type TabWindow } from './paymentTab';
import { centsToApiAmount, readTypedAmount } from '../../server/money';

/** Where Tiny's page stands with Perflo's add money tab. */
type Spot =
  | { kind: 'idle'; note?: 'cancelled' | 'closed' }
  | { kind: 'opening' }
  | { kind: 'waiting'; link: PaymentLink }
  | { kind: 'blocked'; link: PaymentLink }
  | { kind: 'done' }
  | { kind: 'expired' };

export interface PaymentTab {
  spot: Spot;
  error: string;
  /** From the click: opens the tab at once, then sends it to the link `fetchLink` gets. */
  start: (fetchLink: () => Promise<PaymentLink | null>) => void;
  /** Back to the start, after money was added. */
  reset: () => void;
}

/**
 * The add money tab, for one place on Tiny's page. `paid` runs when the page says the money was added;
 * `closed` when the tab was closed without a word, so the caller reads the status it already uses once.
 */
export function usePaymentTab(on: { paid: () => void; closed: () => void }): PaymentTab & { view: (done?: ReactNode) => ReactNode } {
  const [spot, setSpot] = useState<Spot>({ kind: 'idle' });
  const [error, setError] = useState('');
  const latest = useRef(on);
  latest.current = on;
  const tab = useRef<TabWindow | null>(null);
  const stopWatching = useRef<(() => void) | null>(null);
  const lastFetch = useRef<(() => Promise<PaymentLink | null>) | null>(null);
  useEffect(() => () => stopWatching.current?.(), []);

  const watch = (opened: TabWindow, link: PaymentLink) => {
    stopWatching.current?.();
    tab.current = opened;
    setSpot({ kind: 'waiting', link });
    stopWatching.current = watchPaymentTab(browserTabs, opened, link.url, {
      // Every event the page sends goes to the developer log, as for an embedded page.
      event: (event) => void api.frameEvent(event).catch(() => undefined),
      end: (end) => {
        stopWatching.current = null;
        tab.current = null;
        if (end === 'paid') {
          setSpot({ kind: 'done' });
          latest.current.paid();
        } else if (end === 'expired') {
          opened.close();
          setSpot({ kind: 'expired' });
        } else {
          setSpot({ kind: 'idle', note: end });
          if (end === 'closed') latest.current.closed();
        }
      },
    });
  };

  const start = (fetchLink: () => Promise<PaymentLink | null>) => {
    setError('');
    setSpot({ kind: 'opening' });
    lastFetch.current = fetchLink;
    openPaymentTab(browserTabs, fetchLink)
      .then((handoff) => {
        if (handoff.kind === 'opened') watch(handoff.tab, handoff.link);
        else if (handoff.kind === 'blocked') setSpot({ kind: 'blocked', link: handoff.link });
        else setSpot({ kind: 'idle' });
      })
      .catch((e: unknown) => {
        setSpot({ kind: 'idle' });
        setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
      });
  };

  /** The page again: the tab still open is brought forward, else the link opens in a new one. True when it opened. */
  const reopen = (link: PaymentLink): boolean => {
    if (tab.current && !tab.current.closed) {
      tab.current.focus();
      return true;
    }
    const opened = browserTabs.open(link.url);
    if (!opened) return false;
    watch(opened, link);
    return true;
  };

  /**
   * Tiny's Cancel: closes the tab it opened and goes back to the start. Perflo offers a partner no way to
   * cancel a top-up; the page itself stops its payment when its tab closes.
   */
  const cancel = () => {
    stopWatching.current?.();
    stopWatching.current = null;
    tab.current?.close();
    tab.current = null;
    setSpot({ kind: 'idle', note: 'cancelled' });
  };

  const reset = () => setSpot({ kind: 'idle' });

  const view = (done?: ReactNode): ReactNode => {
    switch (spot.kind) {
      case 'idle':
        return spot.note ? <p className="muted small">{PAYMENT_TAB_TEXT[spot.note]}</p> : null;
      case 'opening':
        return (
          <p className="working" role="status">
            {PAYMENT_TAB_TEXT.opening}
          </p>
        );
      case 'waiting':
        return (
          <div className="tab-spot" role="status">
            <p className="tab-spot-title">{PAYMENT_TAB_TEXT.waitingTitle}</p>
            <p className="muted small">{PAYMENT_TAB_TEXT.waiting(spot.link.amount)}</p>
            <div className="row">
              <button className="secondary" onClick={() => reopen(spot.link)}>
                {PAYMENT_TAB_TEXT.reopen}
              </button>
              <button className="link" onClick={cancel}>
                {PAYMENT_TAB_TEXT.cancel}
              </button>
            </div>
          </div>
        );
      case 'blocked':
        return (
          <div className="tab-spot" role="alert">
            <p className="tab-spot-title">{PAYMENT_TAB_TEXT.blockedTitle}</p>
            <div className="row">
              {/* A real link, so it opens even when the browser stops every script-opened tab. */}
              <a
                className="button primary"
                href={spot.link.url}
                target="_blank"
                rel="opener"
                onClick={(event) => {
                  if (reopen(spot.link)) event.preventDefault();
                }}
              >
                {PAYMENT_TAB_TEXT.blockedLink}
              </a>
              <button className="link" onClick={cancel}>
                {PAYMENT_TAB_TEXT.cancel}
              </button>
            </div>
          </div>
        );
      case 'done':
        return (
          <div className="tab-spot" role="status">
            <p className="done">{PAYMENT_TAB_TEXT.done}</p>
            {done}
          </div>
        );
      case 'expired':
        return (
          <div className="problem">
            <p>{pageExpiredText('payment')}</p>
            <button className="secondary" onClick={() => lastFetch.current && start(lastFetch.current)}>
              Start again
            </button>
          </div>
        );
    }
  };

  return { spot, error, start, reset, view };
}

/**
 * Add money with Tiny's own amount field: the person types the amount here, Perflo is asked for a page
 * for exactly that amount, and the page opens in a new tab. Used by the Payments panel and the UI
 * elements page, so the question is asked one way everywhere.
 */
export function AddMoney({ onAccountChanged, id }: { onAccountChanged: () => void; id: string }) {
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState('');
  const payment = usePaymentTab({ paid: onAccountChanged, closed: onAccountChanged });

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const typed = readTypedAmount(amount);
    if ('problem' in typed) {
      setProblem(typed.problem);
      return;
    }
    setProblem('');
    payment.start(async () => {
      const link = await api.topUp(centsToApiAmount(typed.cents));
      return { url: link.frameUrl, amount: link.amount };
    });
  };

  const { kind } = payment.spot;
  if (kind !== 'idle' && kind !== 'opening') {
    return (
      <>
        {payment.view(
          <button
            className="secondary"
            onClick={() => {
              setAmount('');
              payment.reset();
            }}
          >
            Add more money
          </button>,
        )}
      </>
    );
  }
  const message = problem || payment.error;
  return (
    <form className="add-money" onSubmit={submit} noValidate>
      <label htmlFor={id}>Amount to add</label>
      <div className="row">
        <span className="amount-field">
          <span aria-hidden="true">$</span>
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            maxLength={12}
            value={amount}
            aria-invalid={problem !== ''}
            aria-describedby={message ? `${id}-problem` : undefined}
            onChange={(e) => setAmount(e.target.value)}
          />
        </span>
        <button type="submit" className="primary" disabled={kind === 'opening'}>
          Add money
        </button>
      </div>
      {payment.view()}
      {message && (
        <p className="error" role="alert" id={`${id}-problem`}>
          {message}
        </p>
      )}
    </form>
  );
}
