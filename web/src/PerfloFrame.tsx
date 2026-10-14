import { useEffect, useRef, useState } from 'react';
import { api, type FrameEventPayload } from './api';
import { readFrameEvent } from './frameEvents';
import { hasPerfloJs, loadPerflo } from './perflo';
import type { LinkStatus, PerfloPageView } from '../../server/views';

interface Props {
  page: PerfloPageView;
  title: string;
  perfloOrigin: string;
  height?: number;
  onEvent: (event: FrameEventPayload, link: LinkStatus | undefined) => void;
}

const CANNOT_OPEN = 'This payment page could not be opened. Try again.';

/**
 * A Perflo embedded page inside Tiny. With Perflo.js (live mode) it is opened from the page's
 * client_secret, in the look Tiny's server asked for when it opened the page. Without Perflo.js (the
 * test payments service), or when Perflo sent no client_secret, it is embedded from its link.
 * Either way, only messages from that page's own window, from the payments origin, are accepted.
 */
export function PerfloFrame({ page, title, perfloOrigin, height = 560, onEvent }: Props) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);
  const viaScript = hasPerfloJs() && page.clientSecret !== undefined;

  let linkAllowed = false;
  try {
    linkAllowed = new URL(page.url).origin === perfloOrigin;
  } catch {
    linkAllowed = false;
  }

  useEffect(() => {
    if (!viaScript && !linkAllowed) return;
    const listen = (message: MessageEvent) => {
      if (message.origin !== perfloOrigin) return;
      // Perflo.js places the page's own window inside `box`; without it, it is the iframe below.
      const source = viaScript ? box.current?.querySelector('iframe')?.contentWindow : frame.current?.contentWindow;
      if (!source || message.source !== source) return;
      const event = readFrameEvent(message.data);
      if (!event) return;
      api
        .frameEvent(event)
        .then((result) => handler.current(event, result.link))
        .catch(() => handler.current(event, undefined));
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [viaScript, linkAllowed, perfloOrigin]);

  const clientSecret = page.clientSecret;
  useEffect(() => {
    if (!viaScript || clientSecret === undefined) return;
    let stopped = false;
    let placed: { destroy(): void } | null = null;
    setFailed(false);
    loadPerflo()
      .then((perflo) => {
        if (stopped || !box.current) return;
        placed = perflo.embeddedPage({ clientSecret }).mount(box.current);
      })
      .catch(() => {
        if (!stopped) setFailed(true);
      });
    return () => {
      stopped = true;
      placed?.destroy();
    };
  }, [viaScript, clientSecret]);

  if (viaScript) {
    if (failed) return <p className="error">{CANNOT_OPEN}</p>;
    return <div ref={box} className="perflo-frame embedded-page" role="region" aria-label={title} style={{ height }} />;
  }
  if (!linkAllowed) return <p className="error">{CANNOT_OPEN}</p>;
  return <iframe ref={frame} className="perflo-frame" src={page.url} title={title} allow="payment" style={{ height }} />;
}
