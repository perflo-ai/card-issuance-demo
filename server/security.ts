/**
 * HTTP hardening for Tiny's own server: response headers, a same-origin check
 * on every state-changing request, and a small rate limiter.
 *
 * No extra dependency: each piece is a few lines, and a partner copying this
 * template can swap in helmet or express-rate-limit without changing callers.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface HeaderOptions {
  /** Origin of the payments service: the only place Perflo.js loads from, and where the pages it places come from. */
  perfloOrigin: string;
  /** Where Perflo hands out its page links (PERFLO_CHECKOUT_ORIGIN), or null when they are on `perfloOrigin`. */
  checkoutOrigin: string | null;
  /** The built web app is served (strict script policy). Off while Vite serves the page in development. */
  production: boolean;
  /** Behind a host that terminates HTTPS. */
  hosted: boolean;
}

/**
 * Headers on every response. The page embeds Perflo's pages and nothing else:
 * frame-src names Perflo's origins (PERFLO_API_BASE's, where Perflo.js places
 * its pages, and PERFLO_CHECKOUT_ORIGIN when set, where Perflo hands out the
 * page links: production's https://api.perflo.ai and https://checkout.perflo.ai,
 * or whichever hosts the demo points at, never a list written here), scripts
 * come from Tiny's own origin and Perflo.js from the API origin only,
 * connections stay on Tiny's own origin (Perflo.js makes none), and no one may
 * frame Tiny itself. Development keeps only the framing rule, because Vite
 * injects inline scripts for hot reload.
 */
export function securityHeaders({ perfloOrigin, checkoutOrigin, production, hosted }: HeaderOptions): RequestHandler {
  const pageOrigins = checkoutOrigin === null || checkoutOrigin === perfloOrigin ? [perfloOrigin] : [perfloOrigin, checkoutOrigin];
  const csp = production
    ? [
        "default-src 'self'",
        `script-src 'self' ${perfloOrigin}`,
        "style-src 'self' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "img-src 'self' data:",
        "connect-src 'self'",
        `frame-src ${pageOrigins.join(' ')}`,
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join('; ')
    : "frame-ancestors 'none'";
  return (_req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      // Not plain same-origin: Perflo's add money page opens in a tab Tiny's page opens, and tells this
      // page when the person is done (window.opener). Windows from anywhere else still get no link here.
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      // Perflo's frames take card payments, so they alone may use the Payment Request API.
      'Permissions-Policy': `camera=(), microphone=(), geolocation=(), payment=(self ${pageOrigins.map((o) => `"${o}"`).join(' ')})`,
    });
    if (hosted) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

/**
 * Refuses a state-changing request that did not come from Tiny's own page.
 * Browsers send Origin on every POST; a form or script on another site carries
 * that site's origin. Together with SameSite cookies and JSON-only bodies this
 * is the CSRF defence. With `publicOrigin` the Origin must be exactly that;
 * without it, its host must match the Host header (the forwarded one behind a
 * trusted proxy).
 */
export function sameOriginOnly({ publicOrigin, trustProxy }: { publicOrigin: string | null; trustProxy: boolean }): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    const origin = req.get('origin');
    let allowed: boolean;
    if (publicOrigin !== null) {
      allowed = origin === publicOrigin;
    } else {
      const host = (trustProxy && req.get('x-forwarded-host')?.split(',')[0]?.trim()) || req.get('host');
      try {
        allowed = origin !== undefined && host !== undefined && new URL(origin).host === host;
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      res.status(403).json({ error: { message: 'This request did not come from Tiny. Reload the page and try again.' } });
      return;
    }
    next();
  };
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Which requests count; all of them when absent. */
  counts?: (req: Request) => boolean;
  now?: () => number;
}

/**
 * Fixed-window limit per client address. In memory, so per process.
 *
 * ponytail: one process only; a partner running several instances moves the
 * counters to a shared store (Redis) or to their edge.
 */
export function rateLimit({ windowMs, max, counts = () => true, now = Date.now }: RateLimitOptions): RequestHandler {
  const windows = new Map<string, { start: number; hits: number }>();
  let lastSweep = now();
  return (req: Request, res: Response, next: NextFunction) => {
    if (!counts(req)) {
      next();
      return;
    }
    const at = now();
    if (at - lastSweep > windowMs) {
      for (const [key, window] of windows) if (at - window.start >= windowMs) windows.delete(key);
      lastSweep = at;
    }
    const key = req.ip ?? 'unknown';
    let window = windows.get(key);
    if (!window || at - window.start >= windowMs) {
      window = { start: at, hits: 0 };
      windows.set(key, window);
    }
    window.hits++;
    if (window.hits > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((window.start + windowMs - at) / 1000))));
      res.status(429).json({ error: { message: 'Too many requests. Wait a moment and try again.' } });
      return;
    }
    next();
  };
}
