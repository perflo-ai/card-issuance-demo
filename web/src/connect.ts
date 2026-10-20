/**
 * What a finished connection came to, shared by the embedded connect page (Setup.tsx) and the UI
 * elements page. No browser objects here, so it is tested on its own.
 */

import type { LinkStatus } from '../../server/views';

/** After a connection is finished on Perflo's side, how long Tiny waits for Perflo's word before saying it is slow. */
export const CONNECT_WAIT_MS = 20_000;

/**
 * `first` is what Tiny's server already found, if it looked. Still pending (or not looked yet):
 * `wait` for Perflo's word that payments are connected (the user.connected webhook, passed on by
 * Tiny's server), then one `look`, which also picks up Tiny's access. null when `signal` stopped it.
 */
export async function settleConnection(
  first: LinkStatus | undefined,
  look: () => Promise<LinkStatus>,
  wait: (signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<LinkStatus | null> {
  if (first !== undefined && first !== 'pending') return first;
  await wait(signal);
  if (signal.aborted) return null;
  // Heard, or not heard in time: one look decides.
  return look().catch((): LinkStatus => 'pending');
}
