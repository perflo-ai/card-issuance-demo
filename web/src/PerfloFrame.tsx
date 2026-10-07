import { useEffect, useRef } from 'react';
import { api, type FrameEventPayload } from './api';
import { readFrameEvent } from './frameEvents';
import type { LinkStatus } from '../../server/views';

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
