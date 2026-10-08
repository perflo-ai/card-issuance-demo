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
}

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

  return {
    mode,
    perfloApiBase: base.toString().replace(/\/$/, ''),
    perfloOrigin: base.origin,
    credentials: { partnerId, keyVersion, secret },
    dataFile: env.DEMO_DATA_FILE?.trim() || 'data/demo-store.json',
    listen,
  };
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
