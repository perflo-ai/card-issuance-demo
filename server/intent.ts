/**
 * The scripted assistant's parser. No model: a message is an order when it
 * names an amount and a website. Anything it cannot read with confidence is
 * reported as missing so the assistant asks, instead of guessing.
 */

import { parseDecimalToCents } from './money.js';
import type { OrderIntent } from './store.js';

/** Store names people say without a domain. Anything else must be written as a domain. */
const KNOWN_MERCHANTS: Record<string, { name: string; domain: string }> = {
  amazon: { name: 'Amazon', domain: 'amazon.com' },
  united: { name: 'United', domain: 'united.com' },
  uber: { name: 'Uber', domain: 'uber.com' },
  delta: { name: 'Delta', domain: 'delta.com' },
  target: { name: 'Target', domain: 'target.com' },
  walmart: { name: 'Walmart', domain: 'walmart.com' },
  ebay: { name: 'eBay', domain: 'ebay.com' },
  airbnb: { name: 'Airbnb', domain: 'airbnb.com' },
  doordash: { name: 'DoorDash', domain: 'doordash.com' },
  instacart: { name: 'Instacart', domain: 'instacart.com' },
  bestbuy: { name: 'Best Buy', domain: 'bestbuy.com' },
  'best buy': { name: 'Best Buy', domain: 'bestbuy.com' },
};

/** Largest single order the demo will even try; the real ceiling is the user's own limit. */
export const MAX_ORDER_CENTS = 100_000_00;

const DOMAIN_PATTERN = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/i;
const DOLLAR_AMOUNT = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)\b/;
const BARE_DECIMAL = /(?<![\w.$])([0-9][0-9,]*\.[0-9]{2})(?![\w.])/;
const WORD_DOLLARS = /\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:dollars|usd|bucks)\b/i;

export type ParseResult =
  | { kind: 'order'; intent: OrderIntent }
  | { kind: 'incomplete'; missing: Array<'amount' | 'merchant'>; problem?: string }
  | { kind: 'not_an_order' };

const ORDER_WORDS = /\b(buy|book|order|pay|get|purchase|reserve|grab|pick up|checkout|check out)\b/i;

function findAmount(text: string): { cents: number | null; raw: string | null; invalid: boolean } {
  for (const pattern of [DOLLAR_AMOUNT, WORD_DOLLARS, BARE_DECIMAL]) {
    const match = pattern.exec(text);
    if (match) {
      const cents = parseDecimalToCents(match[1]);
      return { cents, raw: match[0], invalid: cents === null };
    }
  }
  return { cents: null, raw: null, invalid: false };
}

function findMerchant(text: string): { name: string; domain: string; raw: string } | null {
  const domain = DOMAIN_PATTERN.exec(text);
  if (domain) {
    const host = domain[1].toLowerCase().replace(/^www\./, '');
    const label = host.split('.')[0];
    const known = Object.values(KNOWN_MERCHANTS).find((m) => m.domain === host);
    return { name: known?.name ?? label.charAt(0).toUpperCase() + label.slice(1), domain: host, raw: domain[0] };
  }
  const lower = text.toLowerCase();
  // Longest names first so "best buy" wins over a shorter overlap.
  for (const key of Object.keys(KNOWN_MERCHANTS).sort((a, b) => b.length - a.length)) {
    const match = new RegExp(`\\b${key}\\b`, 'i').exec(lower);
    if (match) return { ...KNOWN_MERCHANTS[key], raw: text.slice(match.index, match.index + key.length) };
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes a matched phrase together with the preposition that introduced it ("on amazon", "for $249"). */
function removePhrase(text: string, raw: string): string {
  return text.replace(new RegExp(`(?:\\b(?:on|at|from|via|using|for)\\s+)?${escapeRegExp(raw)}`, 'i'), ' ');
}

/** What is left once the verb, amount and store are taken out: "headphones", "flight". */
function describe(text: string, amountRaw: string, merchantRaw: string): string {
  const rest = removePhrase(removePhrase(` ${text} `, amountRaw), merchantRaw)
    .replace(/\b(please|can you|could you|for me|i want|i'd like|i would like)\b/gi, ' ')
    .replace(/^\s*(buy|book|order|pay for|pay|get|purchase|reserve|grab|pick up|check out|checkout)\b/i, ' ')
    .replace(/^\s*me\b/i, ' ')
    .replace(/\bworth of\b/gi, ' ')
    .replace(/[.,!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an|of|some)\s+/i, '')
    .trim();
  return rest.slice(0, 120);
}

export function parseOrderMessage(input: string): ParseResult {
  const text = input.trim().slice(0, 500);
  if (text.length === 0) return { kind: 'not_an_order' };

  const amount = findAmount(text);
  const merchant = findMerchant(text);
  const looksLikeOrder = ORDER_WORDS.test(text) || amount.raw !== null || merchant !== null;
  if (!looksLikeOrder) return { kind: 'not_an_order' };

  const missing: Array<'amount' | 'merchant'> = [];
  if (amount.cents === null) missing.push('amount');
  if (merchant === null) missing.push('merchant');
  if (missing.length > 0) {
    return { kind: 'incomplete', missing, ...(amount.invalid ? { problem: 'amount_unreadable' } : {}) };
  }
  const cents = amount.cents as number;
  if (cents <= 0) return { kind: 'incomplete', missing: ['amount'], problem: 'amount_zero' };
  if (cents > MAX_ORDER_CENTS) return { kind: 'incomplete', missing: ['amount'], problem: 'amount_too_large' };

  const m = merchant as { name: string; domain: string; raw: string };
  return {
    kind: 'order',
    intent: {
      merchantName: m.name,
      domain: m.domain,
      amountCents: cents,
      description: describe(text, amount.raw as string, m.raw),
    },
  };
}
