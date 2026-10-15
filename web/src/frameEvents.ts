import type { FrameEventPayload } from './api';
import { FRAME_EVENT_TYPES } from '../../server/views';

const EVENT_TYPES: ReadonlySet<string> = new Set(FRAME_EVENT_TYPES);

const OPTIONAL_IDS = ['login_id', 'top_up_id', 'order_id', 'code'] as const;

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
