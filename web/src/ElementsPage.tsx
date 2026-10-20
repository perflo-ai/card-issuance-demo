import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AddMoney } from './AddMoney';
import { api } from './api';
import { useOnMount } from './browser';
import { elementProblem, isAlreadyConnected, isExpired, LOAD_FAILED_TEXT, NOT_OFFERED_TEXT } from './elements';
import { untilConnected } from './live';
import {
  hasPerfloJs,
  loadPerflo,
  type ElementError,
  type ElementKind,
  type PerfloElement,
  type PerfloElements,
  type Theme,
} from './perflo';
import { stalledText } from './copy';
import { CONNECT_WAIT_MS, settleConnection } from './connect';
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
 * placed inside them. Connect (the code element, with Tiny's "Send code" and "Verify"), then the
 * limits element (the user presses Allow inside it). Then add money: Tiny's own amount field, and
 * Perflo's payment page for that amount in a new tab (Perflo has no amount or payment element). The
 * look comes from Tiny's server when each one is opened; the light and dark switch changes the open
 * elements live.
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
          Perflo&apos;s connect and limits pieces, placed in Tiny&apos;s layout with Tiny&apos;s own headings and buttons. Light and Dark
          change them right away. You type the amount to add in Tiny, and pay on Perflo&apos;s page in a new tab.
        </p>
        {themeError && (
          <p className="error" role="alert">
            {themeError}
          </p>
        )}
        {linked ? (
          <div className="elements-steps">
            <section aria-labelledby="add-money-title">
              <h3 id="add-money-title">Add money</h3>
              <p className="muted small">Connected. Money you add stays in your balance for Tiny to use.</p>
              <AddMoney id="elements-amount" onAccountChanged={onAccountChanged} />
            </section>
          </div>
        ) : (
          <Connect themeNow={themeNow} register={register} onLinked={onLinked} />
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
  kind: ElementKind,
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

type ConnectStep = 'opening' | 'code' | 'limits' | 'finishing' | 'slow' | 'expired' | 'unavailable';

function Connect({ themeNow, register, onLinked }: PartProps & { onLinked: () => void }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [step, setStep] = useState<ConnectStep>('opening');
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
      const result = await api.connect();
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
    const status = await settleConnection(first, look, (signal) => untilConnected(CONNECT_WAIT_MS, signal), controller.signal);
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
    if (result.error && isAlreadyConnected(result.error)) {
      setStep('limits');
      return;
    }
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

  const connecting = step === 'code' || step === 'limits';
  return (
    <div className="elements-steps">
      <section aria-labelledby="connect-title">
        <h3 id="connect-title">Connect</h3>
        {step === 'opening' && <p className="muted">Loading...</p>}
        {step === 'unavailable' && !problem && <p className="muted">{NOT_OFFERED_TEXT}</p>}
        {step === 'unavailable' && problem && (
          <button className="secondary" onClick={() => void open()}>
            Try again
          </button>
        )}
        <div ref={codeBox} hidden={!connecting} />
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
          <p>That connection attempt expired.</p>
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
