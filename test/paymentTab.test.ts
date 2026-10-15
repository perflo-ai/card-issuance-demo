import { describe, expect, it, vi } from 'vitest';
import { isPaymentLink, openPaymentTab, watchPaymentTab, type TabHost, type TabWindow } from '../web/src/paymentTab.js';

type Message = { origin: string; source: unknown; data: unknown };

/** A browser for the hand-off: tabs it opened, the page's message listeners, and timers moved by hand. */
function fakeHost(options: { blocked?: boolean } = {}) {
  const tabs: Array<TabWindow & { closed: boolean; closeCalls: number }> = [];
  const listeners = new Set<(message: Message) => void>();
  const timers = new Set<() => void>();
  const open = vi.fn((url: string) => {
    if (options.blocked) return null;
    const tab = {
      closed: false,
      closeCalls: 0,
      location: { href: url },
      close() {
        this.closeCalls++;
        this.closed = true;
      },
      focus: vi.fn(),
    };
    tabs.push(tab);
    return tab;
  });
  const host: TabHost = {
    open,
    listen: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    every: (_ms, run) => {
      timers.add(run);
      return () => timers.delete(run);
    },
  };
  return {
    host,
    open,
    tabs,
    post: (message: Message) => {
      for (const listener of [...listeners]) listener(message);
    },
    tick: () => {
      for (const run of [...timers]) run();
    },
    listening: () => listeners.size,
    ticking: () => timers.size,
  };
}

const LINK = { url: 'https://checkout.perflo.ai/add-money?session=fs_1', amount: '10.00' };

describe('openPaymentTab: the one hand-off to Perflo’s payment page', () => {
  it('opens a blank tab at once, before the link arrives, then sends it to the link', async () => {
    const browser = fakeHost();
    let answer: (link: typeof LINK) => void = () => undefined;
    const opening = openPaymentTab(browser.host, () => new Promise((done) => (answer = done)));
    // Still inside the click: a pop-up blocker allows only a tab opened here.
    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(browser.open).toHaveBeenCalledWith('about:blank');
    answer(LINK);
    const opened = await opening;
    expect(opened).toEqual({ kind: 'opened', link: LINK, tab: browser.tabs[0] });
    expect(browser.tabs[0].location.href).toBe(LINK.url);
  });

  it('closes the blank tab when the link could not be had, and passes the refusal on', async () => {
    const browser = fakeHost();
    const refusal = new Error('Enter an amount above $0.00.');
    await expect(openPaymentTab(browser.host, () => Promise.reject(refusal))).rejects.toBe(refusal);
    expect(browser.tabs[0].closeCalls).toBe(1);
  });

  it('closes the blank tab when there is nothing to pay any more', async () => {
    const browser = fakeHost();
    expect(await openPaymentTab(browser.host, () => Promise.resolve(null))).toEqual({ kind: 'not_needed' });
    expect(browser.tabs[0].closeCalls).toBe(1);
  });

  it('never sends the tab to a link that is not a web page', async () => {
    const browser = fakeHost();
    await expect(openPaymentTab(browser.host, () => Promise.resolve({ ...LINK, url: 'javascript:alert(1)' }))).rejects.toThrow();
    expect(browser.tabs[0].closeCalls).toBe(1);
    expect(browser.tabs[0].location.href).toBe('about:blank');
  });

  it('says the browser stopped the tab, with the link to open by hand', async () => {
    const browser = fakeHost({ blocked: true });
    expect(await openPaymentTab(browser.host, () => Promise.resolve(LINK))).toEqual({ kind: 'blocked', link: LINK });
  });
});

describe('isPaymentLink', () => {
  it('takes https pages, and http only on this computer (the test payments service)', () => {
    expect(isPaymentLink('https://checkout.perflo.ai/add-money?session=x')).toBe(true);
    expect(isPaymentLink('https://api-dev.perfolio.ai/v1/frames/top-up?session=x')).toBe(true);
    expect(isPaymentLink('http://localhost:3001/v1/frames/top-up?session=x')).toBe(true);
    expect(isPaymentLink('http://example.com/v1/frames/top-up')).toBe(false);
    expect(isPaymentLink('javascript:alert(1)')).toBe(false);
    expect(isPaymentLink('not a link')).toBe(false);
  });
});

describe('watchPaymentTab: what the payment tab says, and a tab closed without a word', () => {
  const opened = () => {
    const browser = fakeHost();
    const tab = browser.host.open(LINK.url) as TabWindow;
    const ends: string[] = [];
    const events: string[] = [];
    const stop = watchPaymentTab(browser.host, tab, LINK.url, {
      event: (event) => events.push(event.type),
      end: (end) => ends.push(end),
    });
    return { browser, tab, ends, events, stop };
  };
  const fromTab = (tab: TabWindow, data: unknown, origin = 'https://checkout.perflo.ai') => ({ origin, source: tab, data });

  it('money added: the paid message from the tab, from the link’s own origin', () => {
    const { browser, tab, ends, events } = opened();
    browser.post(fromTab(tab, { type: 'perflo:ready', frame_session_id: 'fs_1' }));
    browser.post(fromTab(tab, { type: 'perflo:top_up_completed', frame_session_id: 'fs_1', top_up_id: 'tu_1' }));
    expect(events).toEqual(['perflo:ready', 'perflo:top_up_completed']);
    expect(ends).toEqual(['paid']);
    // Done: nothing is listened to or checked any more.
    expect(browser.listening()).toBe(0);
    expect(browser.ticking()).toBe(0);
  });

  it('cancelled: the cancelled message, then the page’s closed', () => {
    const { browser, tab, ends, events } = opened();
    browser.post(fromTab(tab, { type: 'perflo:top_up_cancelled', frame_session_id: 'fs_1', top_up_id: 'tu_1' }));
    browser.post(fromTab(tab, { type: 'perflo:closed', frame_session_id: 'fs_1' }));
    expect(events).toEqual(['perflo:top_up_cancelled']);
    expect(ends).toEqual(['cancelled']);
  });

  it('paid, then "Back to" on the paid page sends closed: still paid', () => {
    const { browser, tab, ends } = opened();
    browser.post(fromTab(tab, { type: 'perflo:top_up_completed', frame_session_id: 'fs_1', top_up_id: 'tu_1' }));
    browser.post(fromTab(tab, { type: 'perflo:closed', frame_session_id: 'fs_1' }));
    expect(ends).toEqual(['paid']);
  });

  it('closed alone, with no outcome before it: ends as closed, so the status is read again', () => {
    const { browser, tab, ends } = opened();
    browser.post(fromTab(tab, { type: 'perflo:closed', frame_session_id: 'fs_1' }));
    tab.close();
    browser.tick();
    expect(ends).toEqual(['closed']);
  });

  it('expired: the page says its time is over', () => {
    const { browser, tab, ends } = opened();
    browser.post(fromTab(tab, { type: 'perflo:error', frame_session_id: 'fs_1', code: 'frame_expired' }));
    expect(ends).toEqual(['expired']);
  });

  it('ignores messages from another window, another origin (the API host too) or in another shape', () => {
    const { browser, tab, ends, events } = opened();
    const paid = { type: 'perflo:top_up_completed', frame_session_id: 'fs_1' };
    browser.post({ origin: 'https://checkout.perflo.ai', source: {}, data: paid });
    browser.post(fromTab(tab, paid, 'https://api.perflo.ai'));
    browser.post(fromTab(tab, paid, 'https://evil.example'));
    browser.post(fromTab(tab, 'perflo:top_up_completed'));
    expect(events).toEqual([]);
    expect(ends).toEqual([]);
  });

  it('a tab closed without a message ends the wait as closed, once', () => {
    const { browser, tab, ends } = opened();
    browser.tick();
    expect(ends).toEqual([]);
    tab.close();
    browser.tick();
    browser.tick();
    expect(ends).toEqual(['closed']);
  });

  it('stopping it (Cancel in Tiny) ends nothing on its own and listens no more', () => {
    const { browser, tab, ends, stop } = opened();
    stop();
    browser.post(fromTab(tab, { type: 'perflo:top_up_completed', frame_session_id: 'fs_1' }));
    expect(ends).toEqual([]);
    expect(browser.listening()).toBe(0);
    expect(browser.ticking()).toBe(0);
  });
});
