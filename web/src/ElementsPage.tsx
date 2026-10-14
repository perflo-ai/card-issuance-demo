import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api } from './api';
import { useOnMount } from './browser';
import { canPay, elementProblem, isExpired, isRecording, LOAD_FAILED_TEXT, NOT_OFFERED_TEXT } from './elements';
import { untilConnected } from './live';
import { hasPerfloJs, loadPerflo, type ElementError, type PerfloElement, type PerfloElements, type Theme } from './perflo';
import { stalledText } from './copy';
import { settleSignIn, SIGN_IN_WAIT_MS } from './signIn';
import type { LinkStatus } from '../../server/views';

/** Every open group of elements, so the light and dark switch reaches all of them. */
type Register = (group: PerfloElements) => () => void;

interface Props {
  linked: boolean;
  onLinked: () => void;
  onAccountChanged: () => void;
}

/**
 * Tiny's own page built from Perflo's UI elements: Tiny's headings and buttons, Perflo's pieces
 * placed inside them. Sign in (the code element, with Tiny's "Send code" and "Verify"), then the
 * limits element (the person presses Allow inside it), then add money (the amount and payment
 * elements, with Tiny's "Pay"). The look comes from Tiny's server when each one is opened; the light
 * and dark switch changes the open elements live.
 */
export function ElementsPage({ linked, onLinked, onAccountChanged }: Props) {
  const [theme, setTheme] = useState<Theme | null>(null);
  const [themeError, setThemeError] = useState('');
  const themeNow = useRef<Theme | null>(null);
  const groups = useRef(new Set<PerfloElements>());

  const register = useCallback<Register>((group) => {
    groups.current.add(group);
    return () => groups.current.delete(group);
  }, []);

  const switchTheme = async (next: Theme) => {
    setThemeError('');
    const before = themeNow.current;
    themeNow.current = next;
    setTheme(next);
    try {
      await Promise.all([...groups.current].map((group) => group.update({ appearance: { theme: next } })));
    } catch {
      // Refused: nothing changed on the elements, so the switch goes back too.
      themeNow.current = before;
      setTheme(before);
      setThemeError('That theme could not be applied. Try again.');
    }
  };

  if (!hasPerfloJs()) {
    return (
      <section className="chat elements-page" aria-label="UI elements">
        <div className="elements-body">
          <h2>UI elements</h2>
          <p className="muted">
            UI elements open with Perflo.js, which the test payments service does not have. Start the demo in live mode, against a Perflo
            that offers UI elements, to try them.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="chat elements-page" aria-label="UI elements">
      <div className="elements-body">
        <div className="elements-head">
          <h2>Payments in Tiny&apos;s own page</h2>
          <div className="theme-switch" role="group" aria-label="Theme">
            {(['light', 'dark'] as const).map((t) => (
              <button key={t} className={theme === t ? 'tab active' : 'tab'} aria-pressed={theme === t} onClick={() => void switchTheme(t)}>
                {t === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
        <p className="muted small">
          Perflo&apos;s sign-in, limits and payment pieces, placed in Tiny&apos;s layout with Tiny&apos;s own headings and buttons. Light
          and Dark change them right away.
        </p>
        {themeError && (
          <p className="error" role="alert">
            {themeError}
          </p>
        )}
        {linked ? (
          <AddMoney themeNow={themeNow} register={register} onAccountChanged={onAccountChanged} />
        ) : (
          <SignIn themeNow={themeNow} register={register} onLinked={onLinked} />
        )}
      </div>
    </section>
  );
}

interface PartProps {
  themeNow: RefObject<Theme | null>;
  register: Register;
}

/** A group of elements for one client_secret, with the given kinds mounted into their boxes. */
function useElements(
  clientSecret: string | null,
  { themeNow, register }: PartProps,
  onReady: (group: PerfloElements) => () => void,
  onLoadProblem: (text: string) => void,
): RefObject<PerfloElements | null> {
  const group = useRef<PerfloElements | null>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const problem = useRef(onLoadProblem);
  problem.current = onLoadProblem;
  useEffect(() => {
    if (clientSecret === null) return;
    let stopped = false;
    let teardown: (() => void) | null = null;
    let unregister: (() => void) | null = null;
    loadPerflo()
      .then((perflo) => {
        if (stopped) return;
        const theme = themeNow.current;
        const made = perflo.elements({ clientSecret, ...(theme ? { appearance: { theme } } : {}) });
        group.current = made;
        unregister = register(made);
        teardown = ready.current(made);
      })
      .catch(() => {
        if (!stopped) problem.current(LOAD_FAILED_TEXT);
      });
    return () => {
      stopped = true;
      teardown?.();
      unregister?.();
      group.current = null;
    };
  }, [clientSecret, themeNow, register]);
  return group;
}

/** Places one element in `box` and reports its state; returns what removes it. */
function place(
  group: PerfloElements,
  kind: 'code' | 'limits' | 'amount' | 'payment',
  box: HTMLElement | null,
  on: { change?: (complete: boolean, error?: ElementError) => void; loadError: (error: ElementError) => void },
): () => void {
  if (!box) return () => undefined;
  const element: PerfloElement = group.create(kind);
  element.on('change', (change) => on.change?.(change.complete, change.error));
  element.on('loaderror', (event) => on.loadError(event.error));
  element.mount(box);
  return () => element.destroy();
}

type SignInStep = 'opening' | 'code' | 'limits' | 'finishing' | 'slow' | 'expired' | 'unavailable';

function SignIn({ themeNow, register, onLinked }: PartProps & { onLinked: () => void }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [step, setStep] = useState<SignInStep>('opening');
  const [codeComplete, setCodeComplete] = useState(false);
  const [busy, setBusy] = useState<'send' | 'verify' | null>(null);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState('');
  const codeBox = useRef<HTMLDivElement>(null);
  const limitsBox = useRef<HTMLDivElement>(null);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);

  const open = async () => {
    setProblem('');
    setStep('opening');
    setSecret(null);
    setSent(false);
    setCodeComplete(false);
    try {
      const result = await api.signIn();
      if (result.link === 'linked') {
        onLinked();
        return;
      }
      if (!result.page.clientSecret) {
        setStep('unavailable');
        return;
      }
      setSecret(result.page.clientSecret);
      setStep('code');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Something went wrong. Try again.');
      setStep('unavailable');
    }
  };
  useOnMount(() => void open());

  const refused = useCallback((error: ElementError) => {
    if (isExpired(error)) setStep('expired');
    setProblem(elementProblem(error));
  }, []);

  /** The limits element finished: the person allowed Tiny to pay. Tiny's server picks up the access. */
  const finish = async () => {
    stop.current?.abort();
    const controller = new AbortController();
    stop.current = controller;
    setStep('finishing');
    const look = () => api.refreshLink().then((r) => r.link);
    const first = await look().catch((): LinkStatus => 'pending');
    const status = await settleSignIn(first, look, (signal) => untilConnected(SIGN_IN_WAIT_MS, signal), controller.signal);
    if (status === null) return;
    if (status === 'linked') onLinked();
    else if (status === 'expired') setStep('expired');
    else setStep('slow');
  };
  const finishing = useRef(finish);
  finishing.current = finish;

  const group = useElements(
    secret,
    { themeNow, register },
    (made) =>
      place(made, 'code', codeBox.current, {
        change: (complete, error) => {
          setCodeComplete(complete);
          if (error) refused(error);
        },
        loadError: refused,
      }),
    setProblem,
  );

  // The limits element only once the code is verified: before that it has nothing to show.
  const showLimits = step === 'limits';
  useEffect(() => {
    if (!showLimits || !group.current) return;
    return place(group.current, 'limits', limitsBox.current, {
      change: (complete, error) => {
        if (error) refused(error);
        if (complete) void finishing.current();
      },
      loadError: refused,
    });
  }, [showLimits, group, refused]);

  const sendCode = async () => {
    if (!group.current) return;
    setProblem('');
    setBusy('send');
    const result = await group.current.sendCode();
    setBusy(null);
    if (result.error) {
      refused(result.error);
      return;
    }
    setSent(true);
  };

  const verify = async () => {
    if (!group.current) return;
    setProblem('');
    setBusy('verify');
    const result = await group.current.verifyCode();
    setBusy(null);
    if (result.error) {
      refused(result.error);
      return;
    }
    setStep('limits');
  };

  const signingIn = step === 'code' || step === 'limits';
  return (
    <div className="elements-steps">
      <section aria-labelledby="sign-in-title">
        <h3 id="sign-in-title">Sign in</h3>
        {step === 'opening' && <p className="muted">Loading...</p>}
        {step === 'unavailable' && !problem && <p className="muted">{NOT_OFFERED_TEXT}</p>}
        {step === 'unavailable' && problem && (
          <button className="secondary" onClick={() => void open()}>
            Try again
          </button>
        )}
        <div ref={codeBox} hidden={!signingIn} />
        {step === 'code' && (
          <div className="row">
            <button className="secondary" disabled={busy !== null} onClick={() => void sendCode()}>
              {busy === 'send' ? 'Sending...' : sent ? 'Send a new code' : 'Send code'}
            </button>
            <button className="primary" disabled={busy !== null || !codeComplete} onClick={() => void verify()}>
              {busy === 'verify' ? 'Verifying...' : 'Verify'}
            </button>
          </div>
        )}
      </section>
      {(step === 'limits' || step === 'finishing' || step === 'slow') && (
        <section aria-labelledby="limits-title">
          <h3 id="limits-title">Allow Tiny to pay</h3>
          <div ref={limitsBox} hidden={step !== 'limits'} />
          {step === 'finishing' && (
            <p className="working" role="status">
              Finishing setup...
            </p>
          )}
          {step === 'slow' && (
            <div className="problem">
              <p>{stalledText('setup')}</p>
              <button className="secondary" onClick={() => void finish()}>
                Check again
              </button>
            </div>
          )}
        </section>
      )}
      {step === 'expired' && (
        <div className="problem">
          <p>That sign-in expired.</p>
          <button className="secondary" onClick={() => void open()}>
            Start again
          </button>
        </div>
      )}
      {problem && step !== 'expired' && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

function AddMoney({ themeNow, register, onAccountChanged }: PartProps & { onAccountChanged: () => void }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [expired, setExpired] = useState(false);
  const [amountComplete, setAmountComplete] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  /** Perflo's words while a card payment that went through has not shown up yet; null otherwise. */
  const [recording, setRecording] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const amountBox = useRef<HTMLDivElement>(null);
  const paymentBox = useRef<HTMLDivElement>(null);

  const open = async () => {
    setProblem('');
    setOpening(true);
    setSecret(null);
    setExpired(false);
    setUnavailable(false);
    setAmountComplete(false);
    setPaymentComplete(false);
    setPaid(false);
    setRecording(null);
    try {
      const link = await api.topUp();
      if (link.clientSecret) setSecret(link.clientSecret);
      else setUnavailable(true);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setOpening(false);
    }
  };
  useOnMount(() => void open());

  const refused = useCallback((error: ElementError) => {
    if (isExpired(error)) setExpired(true);
    setProblem(elementProblem(error));
  }, []);

  const group = useElements(
    secret,
    { themeNow, register },
    (made) => {
      const removeAmount = place(made, 'amount', amountBox.current, {
        change: (complete, error) => {
          setAmountComplete(complete);
          if (error) refused(error);
        },
        loadError: refused,
      });
      const removePayment = place(made, 'payment', paymentBox.current, {
        change: (complete, error) => {
          setPaymentComplete(complete);
          if (error) refused(error);
        },
        loadError: refused,
      });
      return () => {
        removeAmount();
        removePayment();
      };
    },
    setProblem,
  );

  const pay = async () => {
    if (!group.current) return;
    setProblem('');
    setPaying(true);
    const result = await group.current.confirmPayment();
    setPaying(false);
    if (result.error && isRecording(result.error)) {
      // The card was charged; Perflo is still recording it. No Pay again: the live feed updates the
      // balance once it lands, as for any other top-up.
      setRecording(elementProblem(result.error));
      return;
    }
    if (result.error) {
      refused(result.error);
      return;
    }
    setPaid(true);
    onAccountChanged();
  };

  const showing = secret !== null && !expired;
  const payState = { amountComplete, paymentComplete, paying, paid, recording: recording !== null };
  return (
    <div className="elements-steps">
      <section aria-labelledby="add-money-title">
        <h3 id="add-money-title">Add money</h3>
        <p className="muted small">Signed in. Money you add stays in your balance for Tiny to use.</p>
        {opening && <p className="muted">Loading...</p>}
        {unavailable && <p className="muted">{NOT_OFFERED_TEXT}</p>}
        <div ref={amountBox} hidden={!showing} />
        <div ref={paymentBox} hidden={!showing || paid} />
        {showing && !paid && !payState.recording && (
          <button className="primary" disabled={!canPay(payState)} onClick={() => void pay()}>
            {paying ? 'Paying...' : 'Pay'}
          </button>
        )}
        {recording !== null && (
          <p className="working" role="status">
            {recording}
          </p>
        )}
        {paid && (
          <div className="row">
            <p role="status">Money added. It is in your balance for Tiny to use.</p>
            <button className="secondary" onClick={() => void open()}>
              Add more money
            </button>
          </div>
        )}
      </section>
      {expired && (
        <div className="problem">
          <p>This payment page expired.</p>
          <button className="secondary" onClick={() => void open()}>
            Start again
          </button>
        </div>
      )}
      {problem && !expired && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {!opening && !showing && !unavailable && !expired && problem && (
        <button className="secondary" onClick={() => void open()}>
          Try again
        </button>
      )}
    </div>
  );
}
