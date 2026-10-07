import { useEffect, useRef } from 'react';
import { api, type FrameEventPayload } from './api';
import type { LinkStatus } from '../../server/views';

const EVENT_TYPES = new Set([
  'perflo:ready',
  'perflo:login_completed',
  'perflo:limits_saved',
  'perflo:top_up_completed',
  'perflo:setup_completed',
  'perflo:closed',
  'perflo:error',
]);

const OPTIONAL_IDS = ['login_id', 'top_up_id', 'order_id', 'code'] as const;

/** SPEC 8: the payload is always an object; bare strings and unknown shapes are ignored. */
export function readFrameEvent(data: unknown): FrameEventPayload | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.type !== 'string' || !EVENT_TYPES.has(record.type)) return null;
  if (typeof record.frame_session_id !== 'string') return null;
  const event: FrameEventPayload = { type: record.type, frame_session_id: record.frame_session_id };
  for (const key of OPTIONAL_IDS) {
    if (typeof record[key] === 'string') event[key] = record[key] as string;
  }
  return event;
}

interface Props {
  src: string;
  title: string;
  perfloOrigin: string;
  height?: number;
  onEvent: (event: FrameEventPayload, link: LinkStatus | undefined) => void;
}

/** A Perflo frame inside Tiny. Only messages from that frame, from the payments origin, are accepted. */
export function PerfloFrame({ src, title, perfloOrigin, height = 560, onEvent }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  let allowed = false;
  try {
    allowed = new URL(src).origin === perfloOrigin;
  } catch {
    allowed = false;
  }

  useEffect(() => {
    if (!allowed) return;
    const listen = (message: MessageEvent) => {
      if (message.origin !== perfloOrigin) return;
      if (!frame.current || message.source !== frame.current.contentWindow) return;
      const event = readFrameEvent(message.data);
      if (!event) return;
      api
        .frameEvent(event)
        .then((result) => handler.current(event, result.link))
        .catch(() => handler.current(event, undefined));
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [allowed, perfloOrigin]);

  if (!allowed) {
    return <p className="error">This payment page could not be opened. Try again.</p>;
  }
  return <iframe ref={frame} className="perflo-frame" src={src} title={title} allow="payment" style={{ height }} />;
}
