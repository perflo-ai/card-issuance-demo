import { describe, expect, it } from 'vitest';
import { orderSteps, stepOf, type StepKey } from '../web/src/progress.js';

const keys = (current: StepKey, seen: StepKey[]) => orderSteps(current, new Set(seen)).map((s) => `${s.key}:${s.state}`);

describe('order steps come only from statuses the server returned', () => {
  it('maps every phase to its step, and finished phases to none', () => {
    expect(stepOf('needs_setup')).toBe('setup');
    expect(stepOf('connection_required')).toBe('setup');
    expect(stepOf('identity_check_required')).toBe('identity');
    expect(stepOf('payment_required')).toBe('money');
    expect(stepOf('placing')).toBe('card');
    expect(stepOf('issuing')).toBe('card');
    expect(stepOf('ready')).toBe('pay');
    for (const phase of ['draft', 'discarded', 'completed', 'declined', 'cancelled', 'expired', 'failed'] as const) {
      expect(stepOf(phase)).toBeNull();
    }
  });

  it('lists the identity check and adding money only once the order asked for them', () => {
    expect(keys('card', ['card'])).toEqual(['card:current', 'pay:next']);
    expect(keys('money', ['money'])).toEqual(['money:current', 'card:next', 'pay:next']);
  });

  it('marks earlier steps done and keeps the payments order of checks', () => {
    expect(keys('card', ['setup', 'identity', 'money', 'card'])).toEqual([
      'setup:done',
      'identity:done',
      'money:done',
      'card:current',
      'pay:next',
    ]);
    expect(keys('money', ['identity'])).toEqual(['identity:done', 'money:current', 'card:next', 'pay:next']);
    expect(keys('pay', ['card'])).toEqual(['card:done', 'pay:current']);
  });
});
