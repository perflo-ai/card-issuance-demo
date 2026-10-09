import { describe, expect, it } from 'vitest';
import { EventLog } from '../server/eventLog.js';

describe('event log: one line per change, not one per look', () => {
  it('drops a collapsible entry that repeats the same person\'s previous entry', () => {
    const log = new EventLog();
    log.add('u1', 'api', 'GET /orders/o1 -> 200 issuing', { response: { status: 'issuing' } }, { collapse: true });
    log.add('u1', 'api', 'GET /orders/o1 -> 200 issuing', { response: { status: 'issuing' } }, { collapse: true });
    log.add('u2', 'api', 'GET /orders/o9 -> 200 issuing', undefined, { collapse: true });
    log.add('u1', 'api', 'GET /orders/o1 -> 200 issuing', { response: { status: 'issuing' } }, { collapse: true });
    log.add('u1', 'api', 'GET /orders/o1 -> 200 ready', { response: { status: 'ready' } }, { collapse: true });
    expect(log.forUser('u1').map((e) => e.summary)).toEqual(['GET /orders/o1 -> 200 issuing', 'GET /orders/o1 -> 200 ready']);
    expect(log.forUser('u2')).toHaveLength(1);
  });

  it('keeps a repeat when something else happened in between, or when the detail differs', () => {
    const log = new EventLog();
    log.add('u1', 'api', 'GET /users/x -> 200', { response: { balance: '1.00' } }, { collapse: true });
    log.add('u1', 'api', 'GET /users/x -> 200', { response: { balance: '2.00' } }, { collapse: true });
    log.add('u1', 'frame', 'perflo:ready');
    log.add('u1', 'api', 'GET /users/x -> 200', { response: { balance: '2.00' } }, { collapse: true });
    expect(log.forUser('u1')).toHaveLength(4);
  });

  it('never drops an entry that did not ask to be collapsed, and ids stay in order', () => {
    const log = new EventLog();
    log.add('u1', 'demo', 'Card details shown');
    log.add('u1', 'demo', 'Card details shown');
    const ids = log.forUser('u1').map((e) => e.id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBeGreaterThan(ids[0]);
    expect(log.forUser('u1', ids[0]).map((e) => e.id)).toEqual([ids[1]]);
  });
});
