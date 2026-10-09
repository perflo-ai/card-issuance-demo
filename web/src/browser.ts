import { useEffect, useRef } from 'react';
import type { Visibility } from './polling';

/** The real page: hidden while the tab is in the background or minimised. */
export const pageVisibility: Visibility = {
  hidden: () => document.visibilityState === 'hidden',
  onVisible: (listener) => {
    const handle = () => {
      if (document.visibilityState === 'visible') listener();
    };
    document.addEventListener('visibilitychange', handle);
    return () => document.removeEventListener('visibilitychange', handle);
  },
};

/**
 * Runs `run` once when the component first mounts. React's development mode
 * mounts every component twice; refs survive that, so the second mount does
 * not send the same request again.
 */
export function useOnMount(run: () => void): void {
  const ran = useRef(false);
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    latest.current();
  }, []);
}

/** Calls `run` each time the page comes back into view. */
export function useWhenVisible(run: () => void): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => pageVisibility.onVisible(() => latest.current()), []);
}
