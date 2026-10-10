import { randomBytes } from 'node:crypto';
import { KEY_VERSION_PATTERN, PARTNER_ID_PATTERN, SECRET_PATTERN, type PartnerCredentials } from './signing.js';

/**
 * The browser origin of the demo on this computer. Perflo's dev seed allows
 * exactly this origin to embed frames. A hosted demo is reached at the host's
 * own address, which must be added to the partner's allowed origins in Perflo.
 */
export const DEMO_PORT = 5174;
export const DEMO_ORIGIN = `https://localhost:${DEMO_PORT}`;

export type DemoMode = 'live' | 'mock';

/**
 * local: https://localhost:5174 with the local certificate.
 * hosted: the platform set PORT and terminates HTTPS itself, so the demo
 * listens on that port over plain HTTP on every interface.
 */
export type DemoListen = { kind: 'local' } | { kind: 'hosted'; port: number };

export interface DemoConfig {
  mode: DemoMode;
  /** Origin plus optional path prefix, no trailing slash. */
  perfloApiBase: string;
  perfloOrigin: string;
  credentials: PartnerCredentials;
  dataFile: string;
  listen: DemoListen;
  /**
   * The address people open the demo at, when hosted (DEMO_PUBLIC_ORIGIN). Every state-changing
   * request must come from it. Without it, the request's Origin must match the Host header the
   * host forwards.
   */
  publicOrigin: string | null;
  /**
   * The secret Perflo signs webhooks with (PERFLO_WEBHOOK_SECRET): shown in Perflo Builder once a
   * webhook address is saved. Not the partner API secret. In mock mode, a fresh one per run when unset,
   * which the mock payments service signs with too.
   */
  webhookSecret: string;
  /**
   * Mock mode only (MOCK_REUSE_CARDS=true): the mock answers as a partner in reuse mode does, with
   * every order within a card's 12 hours on the same card. Off: one card per order, as by default.
   */
  mockReuseCards: boolean;
}

/** Webhook secrets as Perflo Builder shows them: whsec_ then 32 random bytes, base64url. */
export const WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9_-]{43}$/;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required (see .env.example)`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const mode = required(env, 'DEMO_MODE');
  if (mode !== 'live' && mode !== 'mock') {
    throw new ConfigError('DEMO_MODE must be "live" or "mock"');
  }

  const rawBase = required(env, 'PERFLO_API_BASE');
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new ConfigError('PERFLO_API_BASE must be an absolute URL, for example http://localhost:3001');
  }
  if (base.search || base.hash) {
    throw new ConfigError('PERFLO_API_BASE must not carry a query string or fragment');
  }
  const isLocal = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLocal)) {
    throw new ConfigError('PERFLO_API_BASE must be https, or http on localhost');
  }
  if (mode === 'mock' && !isLocal) {
    throw new ConfigError('In mock mode PERFLO_API_BASE must be a localhost URL; the mock listens on its port');
  }
  const listen = listenFrom(env);
  if (mode === 'mock' && listen.kind === 'hosted') {
    throw new ConfigError('Mock mode only runs on this computer. Set DEMO_MODE=live to host the demo.');
  }
  if (mode === 'mock' && base.port === String(DEMO_PORT)) {
    throw new ConfigError(`The mock cannot share port ${DEMO_PORT} with the demo`);
  }

  const partnerId = required(env, 'PARTNER_ID');
  if (!PARTNER_ID_PATTERN.test(partnerId)) throw new ConfigError('PARTNER_ID must be a v4 uuid');
  const keyVersion = required(env, 'PARTNER_KEY_VERSION');
  if (!KEY_VERSION_PATTERN.test(keyVersion)) throw new ConfigError('PARTNER_KEY_VERSION must look like v1');
  const secret = required(env, 'PARTNER_SECRET');
  if (!SECRET_PATTERN.test(secret)) {
    // Never echo the value.
    throw new ConfigError('PARTNER_SECRET must be 43 base64url characters');
  }

  const rawWebhookSecret = env.PERFLO_WEBHOOK_SECRET?.trim();
  let webhookSecret: string;
  if (rawWebhookSecret) {
    // Never echo the value.
    if (!WEBHOOK_SECRET_PATTERN.test(rawWebhookSecret))
      throw new ConfigError('PERFLO_WEBHOOK_SECRET must be the whsec_... secret Perflo Builder shows');
    webhookSecret = rawWebhookSecret;
  } else if (mode === 'mock') {
    webhookSecret = `whsec_${randomBytes(32).toString('base64url')}`;
  } else {
    throw new ConfigError(
      'PERFLO_WEBHOOK_SECRET is required in live mode: save the webhook address in Perflo Builder and copy the secret it shows (see README)',
    );
  }

  const rawReuse = env.MOCK_REUSE_CARDS?.trim();
  if (rawReuse && rawReuse !== 'true' && rawReuse !== 'false') throw new ConfigError('MOCK_REUSE_CARDS must be "true" or "false"');
  if (rawReuse && mode !== 'mock') {
    throw new ConfigError('MOCK_REUSE_CARDS is for mock mode only: in live mode Perflo decides whether a card is reused');
  }

  return {
    mode,
    perfloApiBase: base.toString().replace(/\/$/, ''),
    perfloOrigin: base.origin,
    credentials: { partnerId, keyVersion, secret },
    dataFile: env.DEMO_DATA_FILE?.trim() || 'data/demo-store.json',
    listen,
    publicOrigin: publicOriginFrom(env, listen),
    webhookSecret,
    mockReuseCards: rawReuse === 'true',
  };
}

function publicOriginFrom(env: NodeJS.ProcessEnv, listen: DemoListen): string | null {
  const raw = env.DEMO_PUBLIC_ORIGIN?.trim();
  if (!raw) return listen.kind === 'local' ? DEMO_ORIGIN : null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('DEMO_PUBLIC_ORIGIN must be an address such as https://tiny-demo.up.railway.app');
  }
  if (url.protocol !== 'https:' || url.origin !== raw.replace(/\/$/, '')) {
    throw new ConfigError('DEMO_PUBLIC_ORIGIN must be https and only the origin, such as https://tiny-demo.up.railway.app');
  }
  return url.origin;
}

function listenFrom(env: NodeJS.ProcessEnv): DemoListen {
  const raw = env.PORT?.trim();
  if (!raw) return { kind: 'local' };
  const port = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('PORT must be a whole number from 1 to 65535');
  }
  return { kind: 'hosted', port };
}
