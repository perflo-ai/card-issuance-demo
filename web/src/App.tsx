import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import { Chat } from './Chat';
import { Panel } from './Panel';
import type { DemoConfigView, MeView } from '../../server/views';

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
  const [me, setMe] = useState<MeView | null | undefined>(undefined);
  const [fatal, setFatal] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [limitsRequest, setLimitsRequest] = useState(0);

  useEffect(() => {
    api.config().then(setConfig).catch(() => setFatal('Tiny is not reachable. Is the demo server running?'));
    api
      .me()
      .then((r) => setMe(r.user))
      .catch((e: unknown) => (e instanceof ApiError && e.status === 401 ? setMe(null) : setFatal('Could not load your account.')));
  }, []);

  const accountChanged = useCallback(() => setRefreshKey((k) => k + 1), []);

  if (fatal) return <main className="center"><p className="error">{fatal}</p></main>;
  if (!config || me === undefined) return <main className="center"><p className="muted">Loading...</p></main>;

  return (
    <div className="app">
      <header className="top">
        <Logo />
        {config.mode === 'mock' && <span className="badge">Test mode</span>}
        {me && (
          <div className="who">
            <span>{me.firstName}</span>
            <button
              className="link"
              onClick={() => {
                void api.logout().then(() => setMe(null));
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      {me ? (
        <div className="layout">
          <Chat
            perfloOrigin={config.perfloOrigin}
            onAccountChanged={accountChanged}
            onChangeLimits={() => setLimitsRequest((n) => n + 1)}
          />
          <Panel
            perfloOrigin={config.perfloOrigin}
            mode={config.mode}
            refreshKey={refreshKey}
            limitsRequest={limitsRequest}
            onAccountChanged={accountChanged}
            me={me}
            onMe={setMe}
          />
        </div>
      ) : (
        <SignUp onDone={setMe} />
      )}
    </div>
  );
}

function SignUp({ onDone }: { onDone: (me: MeView) => void }) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      onDone((await api.signup(first, last, email)).user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="signup">
      <h1>Welcome to Tiny</h1>
      <p className="muted">Your assistant that books and buys things for you.</p>
      <form onSubmit={submit}>
        <label htmlFor="first">First name</label>
        <input id="first" value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="given-name" required maxLength={100} />
        <label htmlFor="last">Last name</label>
        <input id="last" value={last} onChange={(e) => setLast(e.target.value)} autoComplete="family-name" required maxLength={100} />
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required maxLength={320} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          Continue
        </button>
      </form>
    </main>
  );
}
