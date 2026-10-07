import { describe, expect, it } from 'vitest';
import { parseOrderMessage } from '../server/intent.js';
import { apiAmountToCents, centsToApiAmount, formatUsd, parseDecimalToCents } from '../server/money.js';
import { chatReply } from '../server/app.js';

describe('parseOrderMessage', () => {
  it.each([
    ['buy me $50 worth of headphones on amazon', 'amazon.com', 'Amazon', 5000, 'headphones'],
    ['book the 412.80 flight on united.com', 'united.com', 'United', 41280, 'flight'],
    ['Order the AirPods Pro on Amazon for $249', 'amazon.com', 'Amazon', 24900, 'AirPods Pro'],
    ['Get me an Uber to SFO now, $38.50', 'uber.com', 'Uber', 3850, 'to SFO now'],
    ['pay 1,250.00 dollars at www.Delta.com for seats', 'delta.com', 'Delta', 125000, 'for seats'],
    ['buy a $19.99 phone case from best buy', 'bestbuy.com', 'Best Buy', 1999, 'phone case'],
    ['get $12 of coffee beans on shop.example.co.uk', 'shop.example.co.uk', 'Shop', 1200, 'coffee beans'],
  ])('%s', (text, domain, name, cents, description) => {
    expect(parseOrderMessage(text)).toEqual({
      kind: 'order',
      intent: { domain, merchantName: name, amountCents: cents, description },
    });
  });

  it('asks instead of guessing when the amount is missing', () => {
    expect(parseOrderMessage('buy headphones on amazon')).toEqual({ kind: 'incomplete', missing: ['amount'] });
    // A bare whole number could be a quantity, so it is not taken as dollars.
    expect(parseOrderMessage('buy 2 headphones on amazon')).toEqual({ kind: 'incomplete', missing: ['amount'] });
  });

  it('asks instead of guessing when the website is missing or unknown', () => {
    expect(parseOrderMessage('buy $40 of socks')).toEqual({ kind: 'incomplete', missing: ['merchant'] });
    expect(parseOrderMessage('buy $40 of socks at sockshop')).toEqual({ kind: 'incomplete', missing: ['merchant'] });
  });

  it('refuses zero and absurd amounts', () => {
    expect(parseOrderMessage('buy $0 of air on amazon')).toMatchObject({ kind: 'incomplete', problem: 'amount_zero' });
    expect(parseOrderMessage('buy $999999 of gold on amazon')).toMatchObject({ kind: 'incomplete', problem: 'amount_too_large' });
  });

  it('ignores small talk', () => {
    expect(parseOrderMessage('hello there')).toEqual({ kind: 'not_an_order' });
    expect(parseOrderMessage('   ')).toEqual({ kind: 'not_an_order' });
  });

  it('chat replies are plain and confirm the parsed order', () => {
    expect(chatReply('buy me $50 worth of headphones on amazon').reply).toBe(
      'Got it: $50.00 at amazon.com for headphones. Should I go ahead?',
    );
    expect(chatReply('buy headphones on amazon').reply).toMatch(/^How much should I spend\?/);
    expect(chatReply('hi').intent).toBeUndefined();
  });
});

describe('money', () => {
  it('converts without floating point', () => {
    expect(parseDecimalToCents('412.8')).toBe(41280);
    expect(parseDecimalToCents('1,250.05')).toBe(125005);
    expect(parseDecimalToCents('0.1')).toBe(10);
    expect(parseDecimalToCents('12.345')).toBeNull();
    expect(parseDecimalToCents('-5')).toBeNull();
    expect(centsToApiAmount(41280)).toBe('412.80');
    expect(centsToApiAmount(5)).toBe('0.05');
    expect(apiAmountToCents('412.80')).toBe(41280);
    expect(() => apiAmountToCents('412.8')).toThrow();
    expect(() => centsToApiAmount(1.5)).toThrow();
    expect(formatUsd(125000)).toBe('$1,250.00');
  });
});
