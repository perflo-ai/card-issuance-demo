import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { useOnMount } from './browser';
import { Chat } from './Chat';
import { Panel } from './Panel';
import { shared } from './polling';
import { stepOf, type StepKey } from './progress';
import { SetupFlow } from './Setup';
import type { DemoConfigView, MeView, OrderPhase, OrderView } from '../../server/views';

function Logo() {
  return (
    <span className="logo" aria-label="Tiny">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="10" fill="#141414" />
        <circle cx="11" cy="11" r="4" fill="#fff" />
      </svg>
      <span>tiny</span>
    </span>
  );
}

export function App() {
  const [config, setConfig] = useState<DemoConfigView | null>(null);
  const [me, setMe] = useState<MeView | null>(null);
  const [fatal, setFatal] = useState('');
  const [signingOut, setSigningOut] = useState(false);

  useOnMount(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setFatal('Tiny is not reachable. Is the demo server running?'));
    api
      .session()
      .then((r) => setMe(r.user))
      .catch(() => setFatal('Tiny could not start. Reload the page to try again.'));
  });

  const signOut = async () => {
    setSigningOut(true);
    try {
      await api.logout();
      // The next visitor on this browser starts as a new, anonymous Tiny account.
      setMe((await api.session()).user);
    } catch {
      setFatal('Could not sign you out. Reload the page to try again.');
    } finally {
      setSigningOut(false);
    }
  };

  if (fatal)
    return (
      <main className="center">
        <p className="error">{fatal}</p>
      </main>
    );
  if (!config || !me)
    return (
      <main className="center">
        <p className="muted">Loading...</p>
      </main>
    );

  return (
    <div className="app">
      <header className="top">
        <Logo />
        {config.mode === 'mock' && <span className="badge">Test mode</span>}
        {me.linked && (
          <div className="who">
            <button className="link" disabled={signingOut} onClick={() => void signOut()}>
              {signingOut ? 'Signing out...' : 'Sign out'}
            </button>
          </div>
        )}
      </header>
      {me.linked ? <Workspace config={config} me={me} onMe={setMe} /> : <Connect perfloOrigin={config.perfloOrigin} onConnected={setMe} />}
    </div>
  );
}

/**
 * The first screen: connect payments. Tiny asks for nothing itself; the person
 * types and proves their email inside Perflo's frame.
 */
function Connect({ perfloOrigin, onConnected }: { perfloOrigin: string; onConnected: (me: MeView) => void }) {
  const [error, setError] = useState('');

  const connected = async () => {
    try {
      onConnected((await api.session()).user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Reload the page to try again.');
    }
  };

  return (
    <main className="connect">
      <h1>Welcome to Tiny</h1>
      <p className="muted">Your assistant that books and buys things for you.</p>
      <section className="box">
        <h2>Set up payments for Tiny</h2>
        <p className="muted">Set up payments once. After that I can pay for things for you without stopping to ask.</p>
        <SetupFlow
          perfloOrigin={perfloOrigin}
          open={async () => {
            const result = await api.linkStart();
            if (result.link === 'linked') {
              await connected();
              return null;
            }
            return result.frameUrl ?? null;
          }}
          onLinked={connected}
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}

/**
 * Signed in and connected. The one owner of this person's orders: the chat
 * and the Orders tab read the same list, so an order is never fetched twice
 * to show it in two places.
 */
function Workspace({ config, me, onMe }: { config: DemoConfigView; me: MeView; onMe: (me: MeView) => void }) {
  const [orders, setOrders] = useState<Record<string, OrderView>>({});
  const [seen, setSeen] = useState<Record<string, StepKey[]>>({});
  const [loaded, setLoaded] = useState(false);
  const [ordersError, setOrdersError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [limitsRequest, setLimitsRequest] = useState(0);
  const phases = useRef<Record<string, OrderPhase>>({});

  const accountChanged = useCallback(() => setRefreshKey((k) => k + 1), []);

  /** Records each order's phase and the steps it has been on. True when any known order changed phase. */
  const remember = useCallback((list: OrderView[]): boolean => {
    let moved = false;
    for (const order of list) {
      const before = phases.current[order.id];
      if (before !== undefined && before !== order.phase && order.phase !== 'discarded') moved = true;
      phases.current[order.id] = order.phase;
    }
    setSeen((all) => {
      const next = { ...all };
      for (const order of list) {
        const step = stepOf(order.phase);
        const known = next[order.id] ?? [];
        if (step && !known.includes(step)) next[order.id] = [...known, step];
      }
      return next;
    });
    return moved;
  }, []);

  const putOrder = useCallback(
    (order: OrderView) => {
      setOrders((all) => ({ ...all, [order.id]: order }));
      // Money or access can only have moved when an order changed phase. A look that found
      // the same phase again leaves the balance alone, so it does not ask for it again.
      if (remember([order])) accountChanged();
    },
    [remember, accountChanged],
  );

  const refreshOrders = useMemo(
    () =>
      shared(async () => {
        try {
          const { orders: list } = await api.orders();
          // Merged, not replaced: an order the chat made while this read was on its way is kept.
          setOrders((all) => ({ ...all, ...Object.fromEntries(list.map((o) => [o.id, o])) }));
          if (remember(list)) accountChanged();
          setOrdersError('');
        } catch (e) {
          setOrdersError(e instanceof Error ? e.message : 'Could not load your orders.');
        } finally {
          setLoaded(true);
        }
      }),
    [remember, accountChanged],
  );

  useOnMount(() => void refreshOrders());

  return (
    <div className="layout">
      <Chat
        perfloOrigin={config.perfloOrigin}
        orders={orders}
        seen={seen}
        loaded={loaded}
        onOrder={putOrder}
        onAccountChanged={accountChanged}
        onChangeLimits={() => setLimitsRequest((n) => n + 1)}
      />
      <Panel
        perfloOrigin={config.perfloOrigin}
        mode={config.mode}
        refreshKey={refreshKey}
        limitsRequest={limitsRequest}
        onAccountChanged={accountChanged}
        orders={loaded ? Object.values(orders) : null}
        ordersError={ordersError}
        onRefreshOrders={refreshOrders}
        onOrder={putOrder}
        me={me}
        onMe={onMe}
      />
    </div>
  );
}
