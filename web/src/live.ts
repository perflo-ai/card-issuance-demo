/**
 * The page's live feed from Tiny's server (Server-Sent Events). Tiny's server
 * hears from Perflo by webhook and pushes what changed here, so the page never
 * asks again and again. The page reads its state once when it opens, and once
 * more each time the feed comes back after a drop (anything that changed while
 * it was away is picked up by that one read).
 */

import type { LiveMessage } from '../../server/views';

type Listener = (message: LiveMessage) => void;

const listeners = new Set<Listener>();
const reconnectListeners = new Set<() => void>();

/** Calls `listener` with every message pushed to this page. Returns an unsubscribe. */
export function onLive(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Calls `listener` each time the feed opens again after a drop (not the first time). Returns an unsubscribe. */
export function onReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}

/** Reads one pushed message. Anything that is not a message Tiny sends is ignored. */
export function parseLiveMessage(raw: string): LiveMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) return null;
  const type = value.type;
  return type === 'order' || type === 'account' || type === 'connected' || type === 'log' ? (value as LiveMessage) : null;
}

/**
 * Opens the feed for this page. The browser opens it again by itself after a drop (the server asks
 * for a few seconds' wait). Returns a function that closes it, for signing out.
 */
export function connectLive(): () => void {
  const source = new EventSource('/demo/stream');
  let openedBefore = false;
  source.onopen = () => {
    if (openedBefore) for (const listener of reconnectListeners) listener();
    openedBefore = true;
  };
  source.onmessage = (event: MessageEvent<string>) => {
    const message = parseLiveMessage(event.data);
    if (message) for (const listener of listeners) listener(message);
  };
  return () => source.close();
}

/**
 * Resolves true when Tiny's server passes on Perflo's word that this person's payments are
 * connected (the user.connected webhook), or false after `ms` or when `signal` stops it. A timer for
 * giving up only; nothing is asked meanwhile.
 */
export function untilConnected(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((done) => {
    if (signal?.aborted) return done(false);
    const finish = (linked: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', stop);
      done(linked);
    };
    const stop = () => finish(false);
    const timer = setTimeout(() => finish(false), ms);
    const unsubscribe = onLive((message) => {
      if (message.type === 'connected' || (message.type === 'account' && message.linked)) finish(true);
    });
    signal?.addEventListener('abort', stop, { once: true });
  });
}
