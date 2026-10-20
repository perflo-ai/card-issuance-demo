/**
 * The example looks Tiny can ask Perflo to draw its pages in, sent as `appearance` on the request that
 * opens the page. How the payment form works is Perflo's own; a look only sets how the pages look.
 *
 * A fixed list on purpose: the browser only ever names a look by its id, and the objects sent to
 * Perflo come from here, never from anything the browser sent. A partner building its own look puts
 * its own fixed object here (or in its own config) the same way.
 *
 * The names inside are Perflo's appearance names, which follow Stripe's (theme, inputs, labels,
 * variables, rules). Perflo checks every value again and refuses anything it does not accept, naming
 * the field.
 */

import { LOOK_IDS, type LookId } from './views.js';

export { LOOK_IDS, type LookId } from './views.js';

/** The appearance object, as far as these looks use it. */
export interface Appearance {
  theme?: 'light' | 'dark' | 'auto';
  labels?: 'auto' | 'above' | 'floating';
  inputs?: 'spaced' | 'condensed';
  variables?: Readonly<Record<string, string>>;
  rules?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

interface Look {
  appearance?: Appearance;
}

const LOOKS: Readonly<Record<LookId, Look>> = {
  // Nothing sent: Perflo draws the brand saved for Tiny in Perflo Builder.
  brand: {},
  flat: {
    appearance: {
      theme: 'light',
      inputs: 'condensed',
      variables: {
        colorPrimary: '#0a66ff',
        colorBackground: '#ffffff',
        colorText: '#1a1a1a',
        borderRadius: '2px',
        spacingUnit: '4px',
      },
    },
  },
  night: {
    appearance: {
      theme: 'dark',
      labels: 'above',
      variables: {
        colorPrimary: '#8b7cff',
        colorBackground: '#111318',
        colorText: '#ecedef',
        colorDanger: '#ff6b6b',
        borderRadius: '12px',
      },
      rules: {
        '.Input': { backgroundColor: '#1a1d24', borderColor: '#2c313a' },
        '.Input:focus': { borderColor: '#8b7cff', boxShadow: '0 0 0 3px rgba(139, 124, 255, 0.35)' },
        '.Label': { fontSize: '12px', fontWeight: '600', letterSpacing: '0.04em', textTransform: 'uppercase' },
        '.Button': { fontWeight: '600' },
      },
    },
  },
};

export const DEFAULT_LOOK: LookId = 'brand';

export function isLookId(value: unknown): value is LookId {
  return typeof value === 'string' && (LOOK_IDS as readonly string[]).includes(value);
}

/**
 * The fields to spread into a request body for this look. Empty for the brand default, so a request
 * with it is exactly what Tiny sent before looks existed. A fresh copy each time: nothing a caller
 * does to it reaches the list.
 */
export function lookFields(look: LookId): { appearance?: Appearance } {
  const chosen = LOOKS[look];
  const out: { appearance?: Appearance } = {};
  if (chosen.appearance) out.appearance = structuredClone(chosen.appearance);
  return out;
}
