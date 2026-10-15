/**
 * Handing the person to Perflo's add money page, which always opens in a tab of its own (it refuses to
 * be framed). Every top-up in Tiny goes through `openPaymentTab`: Add money in the Payments panel, on
 * the UI elements page, and an order waiting on money. Pure apart from the browser it is given, so the
 * rules are unit tested (test/paymentTab.test.ts).
 *
 * - The tab is opened blank while the click is still being handled (a pop-up blocker allows only
 *   that), then sent to Perflo's link once Tiny's server has it. If there is no link, the tab closes.
 * - The page tells this page what happened (window.opener): `perflo:top_up_completed` is money added,
 *   `perflo:closed` is cancelled (its X or Cancel). Only messages from that tab, from the link's own
 *   origin, count: in production the page is not on the API's host.
 * - A tab closed without a word is noticed by looking at the tab itself (the browser's own state, not
 *   a request); the caller then reads the status it already uses once. The real browser is
 *   `browserTabs` in browser.ts.
 */

import type { FrameEventPayload } from './api';
import { pageExpired, readFrameEvent } from './frameEvents';

/** What Tiny uses of the tab it opened. Cross-origin, these still work. */
export interface TabWindow {
  readonly closed: boolean;
  close(): void;
  focus(): void;
  location: { href: string };
}

export interface TabHost {
  /** window.open in a new tab; null when the browser stopped it. */
  open(url: string): TabWindow | null;
  /** Every message this page receives. Returns an unsubscribe. */
  listen(handler: (message: { origin: string; source: unknown; data: unknown }) => void): () => void;
  /** Runs `run` every `ms`. Returns a stop. */
  every(ms: number, run: () => void): () => void;
}

/** The add money page Perflo opened, and the amount it is for ("10.00"). */
export interface PaymentLink {
  url: string;
  amount: string;
}

export type Handoff =
  | { kind: 'opened'; link: PaymentLink; tab: TabWindow }
  /** The browser stopped the tab: the person opens the link themselves. */
  | { kind: 'blocked'; link: PaymentLink }
  /** Nothing to pay any more (an order that went ahead meanwhile). */
  | { kind: 'not_needed' };

/** How a wait on the payment tab ended. */
export type TabEnd = 'paid' | 'cancelled' | 'closed' | 'expired';

/** How often Tiny looks whether the tab is still open. */
export const TAB_CHECK_MS = 500;

const CANNOT_OPEN = 'The payment page could not be opened. Try again.';

/** A web page to send the person to: https, or http only on this computer (the test payments service). */
export function isPaymentLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' || (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))
    );
  } catch {
    return false;
  }
}

/**
 * The one hand-off. Call it straight from the click: the tab is opened before anything is awaited.
 * A refusal from `fetchLink` closes the tab and is thrown as it came, with its own plain words.
 */
export async function openPaymentTab(host: TabHost, fetchLink: () => Promise<PaymentLink | null>): Promise<Handoff> {
  const tab = host.open('about:blank');
  let link: PaymentLink | null;
  try {
    link = await fetchLink();
  } catch (error) {
    tab?.close();
    throw error;
  }
  if (link === null) {
    tab?.close();
    return { kind: 'not_needed' };
  }
  if (!isPaymentLink(link.url)) {
    tab?.close();
    throw new Error(CANNOT_OPEN);
  }
  if (!tab) return { kind: 'blocked', link };
  tab.location.href = link.url;
  return { kind: 'opened', link, tab };
}

/**
 * Waits on the payment tab: `end` is called once, with how it ended. Every event the page sends is
 * passed to `event` first (Tiny's server writes it to the developer log). Returns a stop, for when Tiny
 * ends the wait itself (its own Cancel).
 */
export function watchPaymentTab(
  host: TabHost,
  tab: TabWindow,
  url: string,
  on: { event?: (event: FrameEventPayload) => void; end: (end: TabEnd) => void },
): () => void {
  const origin = new URL(url).origin;
  let done = false;
  const stopListening = host.listen((message) => {
    if (message.source !== tab || message.origin !== origin) return;
    const event = readFrameEvent(message.data);
    if (!event) return;
    on.event?.(event);
    if (event.type === 'perflo:top_up_completed') finish('paid');
    else if (event.type === 'perflo:closed') finish('cancelled');
    else if (pageExpired(event)) finish('expired');
  });
  const stopChecking = host.every(TAB_CHECK_MS, () => {
    if (tab.closed) finish('closed');
  });
  function stop() {
    done = true;
    stopListening();
    stopChecking();
  }
  function finish(end: TabEnd) {
    if (done) return;
    stop();
    on.end(end);
  }
  return stop;
}
