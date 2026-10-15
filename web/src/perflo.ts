/**
 * Perflo.js, as Tiny's page uses it: the one script that places Perflo's embedded pages and UI
 * elements on this page. It is loaded once, from the address the server gives (live mode only: the
 * test payments service has none), and Perflo() is called once, because each call listens for
 * messages on its own.
 *
 * Nothing typed in a UI element ever reaches this page: Perflo.js passes back state (empty, complete,
 * an error code and plain words) and the answers to the actions this page asks for.
 */

import type { ElementError } from './elements';

export type { ElementError } from './elements';

export type Theme = 'light' | 'dark';
export type ElementKind = 'code' | 'amount' | 'payment' | 'limits';

export interface ElementChange {
  elementType: ElementKind;
  empty: boolean;
  complete: boolean;
  error?: ElementError;
}

/** What an action answers. It never rejects: a refusal comes back as `error`. */
export interface ActionResult {
  error?: ElementError;
}

export interface PerfloElement {
  mount(target: HTMLElement): PerfloElement;
  destroy(): void;
  on(event: 'change', handler: (change: ElementChange) => void): PerfloElement;
  on(event: 'ready', handler: (event: { elementType: ElementKind }) => void): PerfloElement;
  on(event: 'loaderror', handler: (event: { elementType: ElementKind; error: ElementError }) => void): PerfloElement;
}

/** Only the appearance the light and dark switch changes: every other look is set by Tiny's server. */
export interface RuntimeAppearance {
  theme: Theme;
}

export interface PerfloElements {
  create(kind: ElementKind): PerfloElement;
  sendCode(): Promise<ActionResult>;
  verifyCode(): Promise<ActionResult>;
  confirmPayment(): Promise<ActionResult>;
  /** Rejects with the field's path when Perflo refuses the appearance; nothing changes then. */
  update(options: { appearance: RuntimeAppearance }): Promise<void>;
}

export interface PerfloEmbeddedPage {
  mount(target: HTMLElement): PerfloEmbeddedPage;
  destroy(): void;
  /** The page could not open, for example `session_expired` once its client_secret is past its 30 minutes. */
  on(event: 'loaderror', handler: (event: { error: ElementError }) => void): PerfloEmbeddedPage;
}

export interface PerfloInstance {
  version: string;
  elements(options: { clientSecret: string; appearance?: RuntimeAppearance }): PerfloElements;
  embeddedPage(options: { clientSecret: string }): PerfloEmbeddedPage;
}

declare global {
  interface Window {
    Perflo?: () => PerfloInstance;
  }
}

let scriptUrl: string | null = null;
let loading: Promise<PerfloInstance> | null = null;

/** Where Perflo.js is served from (the server's config), or null when this Perflo has none. Called once. */
export function configurePerflo(url: string | null): void {
  scriptUrl = url;
}

/** True when pages and elements are opened with Perflo.js; false in mock mode, where they open from their links. */
export function hasPerfloJs(): boolean {
  return scriptUrl !== null;
}

/**
 * Perflo.js, loaded the first time it is needed. A classic script on purpose: Perflo.js learns
 * where Perflo is from its own address while it runs, which a module script does not give it. A load
 * that failed is tried again the next time.
 */
export function loadPerflo(): Promise<PerfloInstance> {
  if (loading) return loading;
  const url = scriptUrl;
  if (url === null) return Promise.reject(new Error('Perflo.js is not available here'));
  const attempt = new Promise<PerfloInstance>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => {
      try {
        if (typeof window.Perflo !== 'function') throw new Error('Perflo.js loaded without Perflo()');
        resolve(window.Perflo());
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Perflo.js could not start'));
      }
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Perflo.js did not load'));
    };
    document.head.append(script);
  });
  loading = attempt;
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return attempt;
}
