import { describe, expect, it } from 'vitest';
import { returnedLine } from '../web/src/copy.js';

describe('what went back to the balance', () => {
  it('says plainly that unused money comes back later while a reused card is open', () => {
    expect(returnedLine(null)).toBe('Unused money comes back when the card closes.');
  });

  it('shows the final amount once known, and nothing when nothing went back', () => {
    expect(returnedLine('2.40')).toBe('$2.40 went back to your balance.');
    expect(returnedLine('0.00')).toBeNull();
    expect(returnedLine(undefined)).toBeNull();
  });
});
