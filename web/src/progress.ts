/**
 * Where an order stands, as a list of steps, worked out only from statuses
 * the server has returned for it. Pure, so it is unit tested
 * (test/progress.test.ts).
 *
 * The steps follow the order in which payments checks an order: access first,
 * then the identity check, then the balance, then the card. The identity check
 * and adding money are listed only once the order has actually asked for them.
 */

import type { OrderPhase } from '../../server/views';

export type StepKey = 'setup' | 'identity' | 'money' | 'card' | 'pay';
export type StepState = 'done' | 'current' | 'next';

const ORDER: readonly StepKey[] = ['setup', 'identity', 'money', 'card', 'pay'];

/** The step an order is on while it is in `phase`, or null when the phase is not a step. */
export function stepOf(phase: OrderPhase): StepKey | null {
  switch (phase) {
    case 'needs_setup':
    case 'connection_required':
      return 'setup';
    case 'identity_check_required':
      return 'identity';
    case 'payment_required':
      return 'money';
    case 'placing':
    case 'issuing':
      return 'card';
    case 'ready':
      return 'pay';
    default:
      return null;
  }
}

/**
 * The steps to show for an order on `current`, given every step it has been
 * seen on. Steps before the current one are done, the rest are still to come.
 * Getting the card and paying always happen, so they are always listed.
 */
export function orderSteps(current: StepKey, seen: ReadonlySet<StepKey>): Array<{ key: StepKey; state: StepState }> {
  const shown = ORDER.filter((key) => key === current || seen.has(key) || key === 'card' || key === 'pay');
  const at = shown.indexOf(current);
  return shown.map((key, i) => ({ key, state: i < at ? 'done' : i === at ? 'current' : 'next' }));
}
