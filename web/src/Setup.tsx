import { useEffect, useRef, useState } from 'react';
import { api, type FrameEventPayload } from './api';
import { useFocusWhenClosed } from './browser';
import { SETUP_STEPS, stalledText, waitingText } from './copy';
import { untilConnected } from './live';
import { PerfloFrame } from './PerfloFrame';
import { settleSignIn, SIGN_IN_WAIT_MS } from './signIn';
import { StepList } from './Steps';
import type { LinkStatus, PerfloPageView } from '../../server/views';

interface Props {
  perfloOrigin: string;
  /**
   * The setup page to show, asked of Tiny's server each time (it checks with Perflo that the sign-in
   * still works), or null when there is nothing to open. A throw is shown as the error.
   */
  open: () => Promise<PerfloPageView | null>;
  onLinked: () => void | Promise<void>;
  /** The caller is busy with this account right now. */
  disabled?: boolean;
}

/**
 * The one-time setup, shown in the chat on the order that needs payments set
 * up (or turned back on). The step list follows the frame's own events
 * (code verified, limits saved), never a timer.
 */
export function SetupFlow({ perfloOrigin, open, onLinked, disabled = false }: Props) {
  const [page, setPage] = useState<PerfloPageView | null>(null);
  const [opening, setOpening] = useState(false);
  const [step, setStep] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [problem, setProblem] = useState<'' | 'expired' | 'slow'>('');
  const [error, setError] = useState('');
  const stop = useRef<AbortController | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useFocusWhenClosed(page !== null, box);

  useEffect(() => () => stop.current?.abort(), []);

  const openFrame = async () => {
    setError('');
    setProblem('');
    setOpening(true);
    try {
      const opened = await open();
      if (opened) {
        setStep(0);
        setPage(opened);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setOpening(false);
    }
  };

  /** Settles what the frame reported: linked, expired, or still waiting for the approval to show. */
  const settle = async (status: LinkStatus) => {
    if (status === 'linked') {
      setProblem('');
      await onLinked();
    } else if (status === 'expired') {
      setProblem('expired');
    } else {
      setProblem('slow');
    }
  };

  const finish = async (first: LinkStatus | undefined) => {
    stop.current?.abort();
    const controller = new AbortController();
    stop.current = controller;
    setPage(null);
    setStep(SETUP_STEPS.length);
    setProblem('');
    setFinishing(true);
    try {
      // The page's event already looked once. Perflo's user.connected webhook tells Tiny's server
      // when the approval lands, and the server says so here; nothing is asked meanwhile.
      const status = await settleSignIn(
        first,
        () => api.refreshLink().then((r) => r.link),
        (signal) => untilConnected(SIGN_IN_WAIT_MS, signal),
        controller.signal,
      );
      if (status === null) return;
      setFinishing(false);
      await settle(status);
    } finally {
      if (stop.current === controller) setFinishing(false);
    }
  };

  /** Closed by the person: one look, in case setup was finished before closing. */
  const closed = async () => {
    setPage(null);
    if (step === 0) return;
    const status = await api
      .refreshLink()
      .then((r) => r.link)
      .catch((): LinkStatus => 'pending');
    if (status === 'linked' || status === 'expired') await settle(status);
  };

  const onFrameEvent = (event: FrameEventPayload, link: LinkStatus | undefined) => {
    if (event.type === 'perflo:login_completed') setStep((s) => Math.max(s, 1));
    if (event.type === 'perflo:limits_saved') setStep((s) => Math.max(s, 2));
    if (event.type === 'perflo:setup_completed') void finish(link);
    if (event.type === 'perflo:closed') void closed();
  };

  const showing = page !== null || finishing || problem === 'slow';
  const items = SETUP_STEPS.map((label, i) => ({
    label,
    state: !showing ? ('next' as const) : i < step ? ('done' as const) : i === step ? ('current' as const) : ('next' as const),
  }));

  return (
    <div className="setup" ref={box} tabIndex={-1}>
      <StepList items={items} active={finishing} />
      {page ? (
        <PerfloFrame
          page={page}
          title="Set up payments"
          perfloOrigin={perfloOrigin}
          onEvent={onFrameEvent}
          onExpired={() => {
            setPage(null);
            setProblem('expired');
          }}
        />
      ) : (
        !finishing &&
        problem === '' && (
          <button className="primary" disabled={opening || disabled} onClick={() => void openFrame()}>
            {opening ? 'Opening...' : 'Set up payments'}
          </button>
        )
      )}
      {finishing && (
        <p className="working" role="status">
          {waitingText('setup')}
        </p>
      )}
      {problem === 'expired' && (
        <div className="problem">
          <p>That setup link expired.</p>
          <button className="secondary" disabled={opening || disabled} onClick={() => void openFrame()}>
            Start again
          </button>
        </div>
      )}
      {problem === 'slow' && (
        <div className="problem">
          <p>{stalledText('setup')}</p>
          <button className="secondary" disabled={disabled} onClick={() => void finish(undefined)}>
            Check again
          </button>
        </div>
      )}
      {!page && !finishing && problem === '' && <p className="muted small">About a minute. Only needed once.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
