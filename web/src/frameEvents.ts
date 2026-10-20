import type { FrameEventPayload } from './api';
import { FRAME_EVENT_TYPES } from '../../server/views';

const EVENT_TYPES: ReadonlySet<string> = new Set(FRAME_EVENT_TYPES);

const OPTIONAL_IDS = ['connection_id', 'top_up_id', 'order_id', 'code'] as const;

/** SPEC 8: the payload is always an object; bare strings and unknown shapes are ignored. */
export function readFrameEvent(data: unknown): FrameEventPayload | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.type !== 'string' || !EVENT_TYPES.has(record.type)) return null;
  if (typeof record.frame_session_id !== 'string') return null;
  const event: FrameEventPayload = { type: record.type, frame_session_id: record.frame_session_id };
  for (const key of OPTIONAL_IDS) {
    if (typeof record[key] === 'string') event[key] = record[key];
  }
  return event;
}

/**
 * True when a Perflo page says its time is over: its link and client_secret work for 30 minutes. The
 * page then shows only its own "This page has expired" and Close, so Tiny takes it away and offers to
 * start again with a fresh one from its server.
 */
export function pageExpired(event: FrameEventPayload): boolean {
  return event.type === 'perflo:error' && event.code === 'frame_expired';
}

/** Perflo's two origins, as Tiny's server was told them (GET /demo/config). */
export interface PerfloOrigins {
  /** PERFLO_API_BASE's: Perflo.js, and the pages it places. */
  perflo: string;
  /** PERFLO_CHECKOUT_ORIGIN: where Perflo hands out the page links; null when they are on `perflo`. */
  checkout: string | null;
}

/**
 * The origins a Perflo page inside Tiny may send messages from; empty when the page is not opened at all.
 * - Placed by Perflo.js (`viaScript`): the API origin only, because Perflo.js and its pages stay there.
 * - Opened from its link: only a link on one of Perflo's origins is opened. It is on the checkout origin
 *   when Perflo has one, or on the API origin, where a Perflo without one keeps its pages and where a
 *   link handed out before it had one sends the person on to it. So either origin may speak; the frame's
 *   own window is checked as well (message.source), which is what ties a message to this page.
 */
export function frameOrigins(origins: PerfloOrigins, viaScript: boolean, url: string): string[] {
  if (viaScript) return [origins.perflo];
  const perflo = origins.checkout === null || origins.checkout === origins.perflo ? [origins.perflo] : [origins.perflo, origins.checkout];
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return [];
  }
  return perflo.includes(origin) ? perflo : [];
}
