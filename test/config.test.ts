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
  PERFLO_WEBHOOK_SECRET: `whsec_${'b'.repeat(43)}`,
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

describe('loadConfig: where Perflo hands out its page links (PERFLO_CHECKOUT_ORIGIN)', () => {
  it('is unset by default: every page then comes from the API origin, as before', () => {
    expect(loadConfig({ ...LIVE }).checkoutOrigin).toBeNull();
  });

  it('is the origin Perflo hands the connect, limits and add money links on', () => {
    expect(loadConfig({ ...LIVE, PERFLO_CHECKOUT_ORIGIN: 'https://checkout.perflo.ai' }).checkoutOrigin).toBe('https://checkout.perflo.ai');
    expect(loadConfig({ ...LIVE, PERFLO_CHECKOUT_ORIGIN: 'https://checkout.perflo.ai/' }).checkoutOrigin).toBe(
      'https://checkout.perflo.ai',
    );
  });

  it.each(['checkout.perflo.ai', 'http://checkout.perflo.ai', 'https://checkout.perflo.ai/setup', 'https://checkout.perflo.ai/?a=1'])(
    'refuses PERFLO_CHECKOUT_ORIGIN=%s',
    (origin) => {
      expect(() => loadConfig({ ...LIVE, PERFLO_CHECKOUT_ORIGIN: origin })).toThrow(ConfigError);
    },
  );

  it('in mock mode is a localhost port of its own, where the mock serves the pages', () => {
    const MOCK = { ...LIVE, DEMO_MODE: 'mock', PERFLO_API_BASE: 'https://localhost:8791' };
    expect(loadConfig({ ...MOCK, PERFLO_CHECKOUT_ORIGIN: 'https://localhost:8792' }).checkoutOrigin).toBe('https://localhost:8792');
    for (const origin of ['https://checkout.perflo.ai', 'https://localhost:8791', 'https://localhost:5174']) {
      expect(() => loadConfig({ ...MOCK, PERFLO_CHECKOUT_ORIGIN: origin })).toThrow(ConfigError);
    }
  });
});

describe('loadConfig: the webhook secret', () => {
  it('is required in live mode, because without webhooks nothing on the page would move', () => {
    const { PERFLO_WEBHOOK_SECRET: _unset, ...withoutSecret } = LIVE;
    expect(() => loadConfig(withoutSecret)).toThrow(/PERFLO_WEBHOOK_SECRET is required in live mode/);
  });

  it('must be the whsec_ secret Builder shows, and the error never repeats it', () => {
    const wrong = 'not-a-webhook-secret-but-the-partner-api-secret-1234';
    let message = '';
    try {
      loadConfig({ ...LIVE, PERFLO_WEBHOOK_SECRET: wrong });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/whsec_/);
    expect(message).not.toContain(wrong);
  });

  it('in mock mode is made fresh for the run when unset (the mock signs with the same one)', () => {
    const { PERFLO_WEBHOOK_SECRET: _unset, ...withoutSecret } = LIVE;
    const one = loadConfig({ ...withoutSecret, DEMO_MODE: 'mock', PERFLO_API_BASE: 'https://localhost:8791' }).webhookSecret;
    const two = loadConfig({ ...withoutSecret, DEMO_MODE: 'mock', PERFLO_API_BASE: 'https://localhost:8791' }).webhookSecret;
    expect(one).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(one).not.toBe(two);
  });
});

describe('loadConfig: mock card reuse', () => {
  const MOCK = { ...LIVE, DEMO_MODE: 'mock', PERFLO_API_BASE: 'https://localhost:8791' };

  it('is off unless MOCK_REUSE_CARDS=true', () => {
    expect(loadConfig({ ...MOCK }).mockReuseCards).toBe(false);
    expect(loadConfig({ ...MOCK, MOCK_REUSE_CARDS: 'false' }).mockReuseCards).toBe(false);
    expect(loadConfig({ ...MOCK, MOCK_REUSE_CARDS: 'true' }).mockReuseCards).toBe(true);
  });

  it('refuses any other value, and refuses it in live mode, where Perflo decides', () => {
    expect(() => loadConfig({ ...MOCK, MOCK_REUSE_CARDS: 'yes' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...LIVE, MOCK_REUSE_CARDS: 'true' })).toThrow('MOCK_REUSE_CARDS is for mock mode only');
  });
});
