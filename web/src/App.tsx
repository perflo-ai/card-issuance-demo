import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { useOnMount } from './browser';
import { Chat } from './Chat';
import { ElementsPage } from './ElementsPage';
import { connectLive, onLive, onReconnect } from './live';
import { Panel } from './Panel';
import { configurePerflo } from './perflo';
import { shared } from './polling';
import { stepOf, type StepKey } from './progress';
import type { AccountView, DemoConfigView, MeView, OrderPhase, OrderView } from '../../server/views';

const VIEWS = ['embedded', 'elements'] as const;
type View = (typeof VIEWS)[number];

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
  /** Bumped on sign out, so the chat starts empty for the next person on this browser. */
  const [visit, setVisit] = useState(0);
  /** How Perflo shows up in Tiny: its embedded pages in the chat, or its UI elements in Tiny's own page. */
  const [view, setView] = useState<View>('embedded');

  useOnMount(() => {
    api
      .config()
      .then((loaded) => {
        configurePerflo(loaded.perfloScriptUrl);
        setConfig(loaded);
      })
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
      setVisit((v) => v + 1);
    } catch {
      setFatal('Could not sign you out. Reload the page to try again.');
    } finally {
      setSigningOut(false);
    }
  };

  if (fatal)
    return (
      <main className="center">
        <p className="error" role="alert">
          {fatal}
        </p>
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
        <div className="tabs view-switch" role="group" aria-label="How Perflo shows in Tiny">
          {VIEWS.map((v) => (
            <button key={v} className={view === v ? 'tab active' : 'tab'} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === 'embedded' ? 'Embedded pages' : 'UI elements'}
            </button>
          ))}
        </div>
        {me.linked && (
          <div className="who">
            <button className="link" disabled={signingOut} onClick={() => void signOut()}>
              {signingOut ? 'Signing out...' : 'Sign out'}
            </button>
          </div>
        )}
      </header>
      <Workspace key={visit} config={config} me={me} onMe={setMe} view={view} />
    </div>
  );
}

/**
 * The chat, from the first visit. Payments are set up inside the chat, the
 * first time an order needs them. The one owner of this person's orders: the
 * chat and the Orders tab read the same list, so an order is never fetched
 * twice to show it in two places.
 */
function Workspace({ config, me, onMe, view }: { config: DemoConfigView; me: MeView; onMe: (me: MeView) => void; view: View }) {
  const [orders, setOrders] = useState<Record<string, OrderView>>({});
  const [seen, setSeen] = useState<Record<string, StepKey[]>>({});
  const [loaded, setLoaded] = useState(false);
  const [ordersError, setOrdersError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [limitsRequest, setLimitsRequest] = useState(0);
  /** When the person's budget starts again, from the panel's last account read: the chat says it on an over budget decline. */
  const [budgetResetsAt, setBudgetResetsAt] = useState<string | null>(null);
  const onAccount = useCallback((account: AccountView | null) => setBudgetResetsAt(account?.budget?.resets_at ?? null), []);
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

  // Changes arrive as Tiny's server hears them from Perflo (webhooks); nothing here asks on a timer.
  // After the feed drops and comes back, one read catches up on anything missed meanwhile.
  const meLatest = useRef({ me, onMe });
  meLatest.current = { me, onMe };
  useEffect(() => connectLive(), []);
  useEffect(
    () =>
      onLive((message) => {
        if (message.type === 'order') putOrder(message.order);
        if (message.type === 'account') {
          accountChanged();
          const { me: current, onMe: setMe } = meLatest.current;
          if (current.linked !== message.linked) setMe({ ...current, linked: message.linked });
        }
      }),
    [putOrder, accountChanged],
  );
  useEffect(
    () =>
      onReconnect(() => {
        void refreshOrders();
        accountChanged();
      }),
    [refreshOrders, accountChanged],
  );

  return (
    <div className="layout">
      {view === 'elements' && (
        <ElementsPage
          linked={me.linked}
          onLinked={() => {
            onMe({ ...me, linked: true });
            // The Payments panel reads the balance and limits the person just set.
            accountChanged();
          }}
          onAccountChanged={accountChanged}
        />
      )}
      {/* Kept while UI elements are shown, so the conversation is still there on the way back. */}
      <div className="chat-slot" hidden={view === 'elements'}>
        <Chat
          perfloOrigin={config.perfloOrigin}
          orders={orders}
          seen={seen}
          loaded={loaded}
          onOrder={putOrder}
          onAccountChanged={accountChanged}
          onChangeLimits={() => setLimitsRequest((n) => n + 1)}
          budgetResetsAt={budgetResetsAt}
          onLinked={() => onMe({ ...me, linked: true })}
        />
      </div>
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
        onAccount={onAccount}
      />
    </div>
  );
}
