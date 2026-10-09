/**
 * Where the demo listens. On this computer it is https://localhost:5174 with the
 * local certificate, as always. On a host (Railway and the like) the platform sets
 * PORT, terminates HTTPS itself and has no .env file and no certificate, so the
 * demo listens on that port over plain HTTP on every interface.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../server/config.js';

const LIVE = {
  DEMO_MODE: 'live',
  PERFLO_API_BASE: 'https://api-dev.perfolio.ai',
  PARTNER_ID: 'deb4ed28-805b-4c37-938b-78f18788d9b1',
  PARTNER_KEY_VERSION: 'v1',
  PARTNER_SECRET: 'a'.repeat(43),
};

describe('loadConfig: where the demo listens', () => {
  it('with no PORT it runs on this computer, as before', () => {
    expect(loadConfig({ ...LIVE }).listen).toEqual({ kind: 'local' });
  });

  it('with the PORT a host sets, it listens there', () => {
    expect(loadConfig({ ...LIVE, PORT: '8080' }).listen).toEqual({ kind: 'hosted', port: 8080 });
  });

  it.each(['0', '65536', '80.5', 'abc', '-1'])('refuses PORT=%s', (port) => {
    expect(() => loadConfig({ ...LIVE, PORT: port })).toThrow(ConfigError);
  });

  it('mock mode stays on this computer: its test payments service lives on localhost', () => {
    expect(() => loadConfig({ ...LIVE, DEMO_MODE: 'mock', PERFLO_API_BASE: 'https://localhost:8791', PORT: '8080' })).toThrow(
      'Mock mode only runs on this computer. Set DEMO_MODE=live to host the demo.',
    );
  });
});

describe('loadConfig: the address state-changing requests must come from', () => {
  it('is https://localhost:5174 on this computer', () => {
    expect(loadConfig({ ...LIVE }).publicOrigin).toBe('https://localhost:5174');
  });

  it('is DEMO_PUBLIC_ORIGIN when hosted, or the forwarded host without it', () => {
    expect(loadConfig({ ...LIVE, PORT: '8080', DEMO_PUBLIC_ORIGIN: 'https://tiny-demo.up.railway.app' }).publicOrigin).toBe(
      'https://tiny-demo.up.railway.app',
    );
    expect(loadConfig({ ...LIVE, PORT: '8080' }).publicOrigin).toBeNull();
  });

  it.each(['http://tiny.example', 'https://tiny.example/app', 'tiny.example'])('refuses DEMO_PUBLIC_ORIGIN=%s', (origin) => {
    expect(() => loadConfig({ ...LIVE, PORT: '8080', DEMO_PUBLIC_ORIGIN: origin })).toThrow(ConfigError);
  });
});
