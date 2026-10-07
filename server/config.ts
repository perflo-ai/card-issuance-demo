import { KEY_VERSION_PATTERN, PARTNER_ID_PATTERN, SECRET_PATTERN, type PartnerCredentials } from './signing.js';

/**
 * The browser origin of the demo. Perflo's dev seed allows exactly this origin
 * to embed frames, so it is fixed rather than configurable.
 */
export const DEMO_PORT = 5174;
export const DEMO_ORIGIN = `https://localhost:${DEMO_PORT}`;

export type DemoMode = 'live' | 'mock';

export interface DemoConfig {
  mode: DemoMode;
  /** Origin plus optional path prefix, no trailing slash. */
  perfloApiBase: string;
  perfloOrigin: string;
  credentials: PartnerCredentials;
  dataFile: string;
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
  };
}
