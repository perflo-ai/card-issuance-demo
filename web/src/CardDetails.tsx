import { useState } from 'react';
import { api } from './api';
import type { CardUse } from './cards';
import { cardName, cardNumber, expiry, money, SAME_CARD_TEXT } from './copy';
import type { CardDetailsView } from '../../server/views';

interface Props {
  perfloOrderId: string;
  last4: string;
  /** This order's own limit. A card shared with other orders shows what its open orders are for together. */
  cardLimit?: string;
  /** Whether the card serves other orders too (cards.ts). */
  use: CardUse;
  /** Known from Tiny's own checkout, so the expiry shows before the details are opened. */
  expMonth?: string;
  expYear?: string;
}

/**
 * An open card: a one-time card, or one shared by several orders. The number and security code stay hidden until the
 * person asks; each Show reads them fresh, and Hide (or leaving the screen)
 * drops them from memory.
 */
export function CardDetails({ perfloOrderId, last4, cardLimit, use, expMonth, expYear }: Props) {
  const [card, setCard] = useState<CardDetailsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'number' | 'cvv' | null>(null);

  const show = async () => {
    setError('');
    setBusy(true);
    try {
      setCard((await api.cardDetails(perfloOrderId)).card);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the card details. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const hide = () => {
    setCard(null);
    setCopied(null);
  };

  const copy = async (what: 'number' | 'cvv', value: string) => {
    setError('');
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
    } catch {
      setError('Could not copy. Select the text instead.');
    }
  };

  const month = card?.expMonth ?? expMonth;
  const year = card?.expYear ?? expYear;
  const name = cardName(use.shared);
  const limit = use.shared ? (use.openTotal ?? cardLimit) : cardLimit;

  return (
    <div className="card-face" aria-label={`${name} ending ${last4}`}>
      <div className="card-top">
        <span>{name}</span>
        {limit && <span>up to {money(limit)}</span>}
      </div>
      {use.later && <p className="muted small">{SAME_CARD_TEXT}</p>}
      <p className="card-number">{card ? cardNumber(card.number) : `•••• •••• •••• ${last4}`}</p>
      <div className="card-meta">
        <span>Expires {month && year ? expiry(month, year) : '••/••'}</span>
        <span>CVV {card ? card.cvv : '•••'}</span>
      </div>
      {card?.holderName && <p className="card-name">{card.holderName}</p>}
      <div className="row">
        {card ? (
          <>
            <button className="secondary" onClick={() => void copy('number', card.number)}>
              Copy number
            </button>
            <button className="secondary" onClick={() => void copy('cvv', card.cvv)}>
              Copy CVV
            </button>
            <button className="link" onClick={hide}>
              Hide
            </button>
          </>
        ) : (
          <button className="secondary" disabled={busy} onClick={() => void show()}>
            {busy ? 'Opening...' : 'Show card details'}
          </button>
        )}
      </div>
      {copied && (
        <p className="muted small" role="status">
          {copied === 'number' ? 'Card number copied.' : 'CVV copied.'}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
