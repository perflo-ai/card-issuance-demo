import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { useOnMount } from './browser';
import { autoTopUpText, cardSavedText, linkedCardName, money } from './copy';
import { EXPIRED_TEXT, isExpired, LOAD_FAILED_TEXT } from './elements';
import { autoTopUpChoice, canSave, canSendAgain, cardProblem, MONTHLY_LIMIT_CHOICES } from './cardForm';
import { loadPerflo, type CardSaved, type ElementError, type PerfloCardElement } from './perflo';
import { singleFlight } from './polling';
import type { AutoTopUpChoice, AutoTopUpView, LinkedCardView } from '../../server/views';

/** One Save as it was sent: offered again as it was when its answer never came back. */
interface SaveAttempt {
  cardToken: string;
  autoTopUp: AutoTopUpChoice;
}

type Busy = 'saving' | 'confirming' | 'turning-off' | { remove: string } | null;

const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.');

/**
 * The person's cards and automatic top-ups, in the Payments panel: the cards linked through Tiny (each can
 * be removed), where automatic top-ups stand (with Turn off), and "Link your card", which opens Perflo's
 * card fields in Tiny's own form with Tiny's switch and monthly limit below them.
 */
export function LinkedCards({ onAccountChanged }: { onAccountChanged: () => void }) {
  const [cards, setCards] = useState<LinkedCardView[] | null>(null);
  const [auto, setAuto] = useState<AutoTopUpView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useMemo(
    () =>
      singleFlight(async () => {
        try {
          const [list, state] = await Promise.all([api.linkedCards(), api.autoTopUp()]);
          setCards(list.linkedCards);
          setAuto(state.autoTopUp);
          setLoadError('');
        } catch (e) {
          setLoadError(message(e));
        }
      }),
    [],
  );
  useOnMount(() => void load());

  const remove = async (id: string) => {
    setError('');
    setSaved('');
    setBusy({ remove: id });
    try {
      await api.removeLinkedCard(id);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
      void load();
    }
  };

  const turnOff = async () => {
    setError('');
    setSaved('');
    setBusy('turning-off');
    try {
      await api.turnOffAutoTopUp();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
      void load();
    }
  };

  const onSaved = useCallback(
    (result: CardSaved) => {
      setSaved(cardSavedText(result.linkedCard.last4, result.autoTopUp ? { monthlyLimit: result.autoTopUp.monthlyLimit } : null));
      setFormOpen(false);
      void load();
      onAccountChanged();
    },
    [load, onAccountChanged],
  );

  const removing = typeof busy === 'object' && busy !== null ? busy.remove : null;
  return (
    <>
      <h3>Linked cards</h3>
      <p className="muted small">
        Save a card with Tiny. Your balance can then be topped up from it when it runs low, never above the monthly limit you choose.
      </p>
      {cards === null && !loadError && <p className="muted">Loading...</p>}
      {loadError && (
        <div className="problem">
          <p className="error" role="alert">
            {loadError}
          </p>
          <button className="secondary" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {auto && cards && (
        <dl className="facts">
          <dt>Automatic top-ups</dt>
          <dd>
            {autoTopUpText(auto, cards)}
            {auto.status !== 'off' && (
              <>
                {' '}
                <button className="link" disabled={busy !== null} onClick={() => void turnOff()}>
                  {busy === 'turning-off' ? 'Turning off...' : 'Turn off'}
                </button>
              </>
            )}
          </dd>
        </dl>
      )}
      {cards && cards.length > 0 && (
        <ul className="cards">
          {cards.map((card) => (
            <li key={card.id}>
              <span>
                {linkedCardName(card)}
                {card.usedForAutoTopUp ? ' · used for automatic top-ups' : ''}
              </span>
              <button className="link" disabled={busy !== null} onClick={() => void remove(card.id)}>
                {removing === card.id ? 'Removing...' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {saved && (
        <p className="muted small" role="status">
          {saved}
        </p>
      )}
      {formOpen ? (
        <LinkCardForm busy={busy} setBusy={setBusy} onSaved={onSaved} onClose={() => setFormOpen(false)} />
      ) : (
        <div className="row">
          <button
            className="secondary"
            disabled={busy !== null}
            onClick={() => {
              setSaved('');
              setError('');
              setFormOpen(true);
            }}
          >
            Link your card
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

interface FormProps {
  busy: Busy;
  setBusy: (busy: Busy) => void;
  onSaved: (result: CardSaved) => void;
  onClose: () => void;
}

type FormStep = 'opening' | 'ready' | 'expired' | 'unavailable';

/** Perflo's card fields, then Tiny's "Top up automatically" switch and monthly limit, then Save. */
function LinkCardForm({ busy, setBusy, onSaved, onClose }: FormProps) {
  const [secret, setSecret] = useState<string | null>(null);
  const [step, setStep] = useState<FormStep>('opening');
  const [mounted, setMounted] = useState(false);
  const [autoOn, setAutoOn] = useState(false);
  const [limit, setLimit] = useState('');
  const [problem, setProblem] = useState('');
  /** The last Save, when its answer never came back. */
  const [again, setAgain] = useState<SaveAttempt | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const card = useRef<PerfloCardElement | null>(null);
  const latest = useRef({ onSaved, setBusy });
  latest.current = { onSaved, setBusy };

  const open = async () => {
    setProblem('');
    setAgain(null);
    setStep('opening');
    setSecret(null);
    try {
      setSecret((await api.linkedCardForm()).clientSecret);
      setStep('ready');
    } catch (e) {
      setProblem(message(e));
      setStep('unavailable');
    }
  };
  useOnMount(() => void open());

  const refused = useCallback((error: ElementError) => {
    latest.current.setBusy(null);
    if (isExpired(error)) setStep('expired');
    setProblem(cardProblem(error));
  }, []);

  // The card element, for this client_secret. `saved` and `error` answer a confirmation the card's bank asked for.
  useEffect(() => {
    if (secret === null) return;
    let stopped = false;
    let made: PerfloCardElement | null = null;
    loadPerflo()
      .then((perflo) => {
        if (stopped || !box.current) return;
        made = perflo.elements({ clientSecret: secret }).create('card');
        made.on('ready', () => setMounted(true));
        made.on('loaderror', (event) => refused(event.error));
        made.on('error', (event) => refused(event.error ?? { code: 'unknown_error', message: '' }));
        made.on('saved', (result) => {
          latest.current.setBusy(null);
          latest.current.onSaved(result);
        });
        made.mount(box.current);
        card.current = made;
      })
      .catch(() => {
        if (!stopped) setProblem(LOAD_FAILED_TEXT);
      });
    return () => {
      stopped = true;
      made?.destroy();
      card.current = null;
      setMounted(false);
    };
  }, [secret, refused]);

  // The element shows the agreement for exactly what Tiny's switch and limit say, and nothing when they are off.
  const choice = autoTopUpChoice(autoOn, limit);
  const choiceKey = choice ? choice.monthlyLimit : '';
  useEffect(() => {
    const element = card.current;
    if (!mounted || !element) return;
    void element
      .update({ autoTopUp: choiceKey ? { monthlyLimit: choiceKey } : null })
      .then((result) => {
        if (result?.error) refused(result.error);
      })
      .catch(() => setProblem('Something went wrong. Try again.'));
  }, [mounted, choiceKey, refused]);

  /** Sends one Save to Tiny's server. The same attempt again is the same Save: payments answer it once. */
  const send = async (attempt: SaveAttempt) => {
    setProblem('');
    setAgain(null);
    setBusy('saving');
    try {
      const result = await api.linkCard(attempt);
      if (result.status === 'linked') {
        setBusy(null);
        onSaved({ linkedCard: result.linkedCard, autoTopUp: result.autoTopUp });
        return;
      }
      // The card's bank asks the person to confirm, inside the card element; it reports `saved` or `error`.
      setBusy('confirming');
      const element = card.current;
      if (!element) {
        refused({ code: 'element_unmounted', message: '' });
        return;
      }
      const confirmed = await element.handleNextAction();
      if (confirmed?.error) refused(confirmed.error);
    } catch (e) {
      setBusy(null);
      setProblem(message(e));
      if (e instanceof ApiError && canSendAgain(e.status)) setAgain(attempt);
    }
  };

  const save = async () => {
    const element = card.current;
    if (!element) return;
    setProblem('');
    setAgain(null);
    setBusy('saving');
    const made = await element.createToken();
    if (!made.cardToken) {
      refused(made.error ?? { code: 'unknown_error', message: '' });
      return;
    }
    await send({ cardToken: made.cardToken, autoTopUp: choice });
  };

  const working = busy === 'saving' || busy === 'confirming';
  return (
    <section className="link-card" aria-labelledby="link-card-title">
      <h3 id="link-card-title">Link your card</h3>
      {step === 'opening' && <p className="muted">Loading...</p>}
      <div ref={box} hidden={step !== 'ready'} />
      {step === 'ready' && (
        <>
          <label className="check">
            <input type="checkbox" checked={autoOn} disabled={working} onChange={(e) => setAutoOn(e.target.checked)} />
            Top up automatically
          </label>
          {autoOn && (
            <>
              <label htmlFor="auto-top-up-limit">Monthly limit, up to</label>
              <select id="auto-top-up-limit" className="select" value={limit} disabled={working} onChange={(e) => setLimit(e.target.value)}>
                <option value="">Choose a monthly limit</option>
                {MONTHLY_LIMIT_CHOICES.map((amount) => (
                  <option key={amount} value={amount}>
                    {money(amount)}
                  </option>
                ))}
              </select>
            </>
          )}
          <div className="row">
            <button className="primary" disabled={!mounted || busy !== null || !canSave(autoOn, limit)} onClick={() => void save()}>
              {busy === 'saving' ? 'Saving...' : 'Save'}
            </button>
            <button className="secondary" disabled={working} onClick={onClose}>
              Cancel
            </button>
          </div>
          {busy === 'confirming' && (
            <p className="working" role="status">
              Confirm the card in the form above.
            </p>
          )}
        </>
      )}
      {step === 'expired' && (
        <div className="problem">
          <p>{EXPIRED_TEXT}</p>
          <button className="secondary" onClick={() => void open()}>
            Start again
          </button>
        </div>
      )}
      {problem && step !== 'expired' && (
        <div className="problem">
          <p className="error" role="alert">
            {problem}
          </p>
          {again && (
            <button className="secondary" disabled={busy !== null} onClick={() => void send(again)}>
              Try again
            </button>
          )}
          {step === 'unavailable' && (
            <button className="secondary" onClick={() => void open()}>
              Try again
            </button>
          )}
        </div>
      )}
    </section>
  );
}
