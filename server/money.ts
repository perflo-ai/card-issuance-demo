/**
 * Money at the boundary. The public partner API carries USD as decimal strings
 * with exactly two places ("412.80"); inside the demo everything is integer
 * cents, so there is no float arithmetic anywhere.
 */

const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/;
const API_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/;

/** "50" | "50.5" | "50.50" | "1,250.00" -> cents, or null when it is not a plain amount. */
export function parseDecimalToCents(input: string): number | null {
  const cleaned = input.replace(/,(?=[0-9]{3}(\D|$))/g, '');
  const match = DECIMAL_PATTERN.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = match[2] ? match[2].slice(1).padEnd(2, '0') : '00';
  return whole * 100 + Number(fraction);
}

/** The API wire format: exactly two decimal places. */
export function centsToApiAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError('amount must be a non-negative whole number of cents');
  }
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

/** Strict parse of an amount the API sent us. */
export function apiAmountToCents(amount: string): number {
  if (!API_AMOUNT_PATTERN.test(amount)) {
    throw new RangeError('amount is not a two decimal place string');
  }
  const [whole, fraction] = amount.split('.');
  return Number(whole) * 100 + Number(fraction);
}

export function isApiAmount(value: string): boolean {
  return API_AMOUNT_PATTERN.test(value);
}

/** "$1,250.00" for people. */
export function formatUsd(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  return `$${whole}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * The amount a person typed to add money, read the same way by Tiny's own field and by Tiny's server
 * (which has the last word): whole cents above zero, or what to tell them. A leading "$" is fine.
 */
export function readTypedAmount(typed: string): { cents: number } | { problem: string } {
  const text = typed.trim().replace(/^\$\s*/, '');
  if (text === '') return { problem: 'Enter an amount.' };
  const cents = parseDecimalToCents(text);
  return cents === null || cents <= 0 ? { problem: 'Enter an amount above $0.00.' } : { cents };
}
