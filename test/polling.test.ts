import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoff, poll, shared, singleFlight, type Visibility } from '../web/src/polling.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A page whose visibility the test controls. */
function page(hidden = false) {
  const listeners = new Set<() => void>();
  const visibility: Visibility = {
    hidden: () => hidden,
    onVisible: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    visibility,
    hide: () => {
      hidden = true;
    },
    show: () => {
      hidden = false;
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}

describe('poll', () => {
  it('stops at the first final answer and looks no more', async () => {
    const answers = ['issuing', 'issuing', 'ready', 'ready'];
    const look = vi.fn(async () => answers.shift() as string);
    const end = poll({ look, settled: (s) => s !== 'issuing', delay: () => 1000, budgetMs: 60_000 });
    await vi.runAllTimersAsync();
    expect(await end).toBe('settled');
    expect(look).toHaveBeenCalledTimes(3);
  });

  it('never starts a look before the previous one finished, however slow it is', async () => {
    let running = 0;
    let most = 0;
    let looks = 0;
    const look = async () => {
      running++;
      most = Math.max(most, running);
      looks++;
      await new Promise((done) => setTimeout(done, 5000)); // slower than the delay
      running--;
      return looks;
    };
    const end = poll({ look, settled: (n) => n >= 4, delay: () => 100, budgetMs: 60_000 });
    await vi.runAllTimersAsync();
    expect(await end).toBe('settled');
    expect(looks).toBe(4);
    expect(most).toBe(1);
  });

  it('waits longer each time (backoff) and gives up when the time is used', async () => {
    const times: number[] = [];
    const look = async () => {
      times.push(Date.now());
      return 'issuing';
    };
    const start = Date.now();
    const end = poll({ look, settled: () => false, delay: backoff(1000, 4000, 2), budgetMs: 10_000 });
    await vi.runAllTimersAsync();
    expect(await end).toBe('gave_up');
    expect(times.map((t) => t - start)).toEqual([0, 1000, 3000, 7000, 11_000]);
  });

  it('makes no look while the page is hidden, and looks as soon as it is visible again', async () => {
    const p = page();
    const look = vi.fn(async () => 'issuing');
    const end = poll({ look, settled: (s) => s === 'ready', delay: () => 1000, budgetMs: 10 * 60_000, visibility: p.visibility });
    await vi.advanceTimersByTimeAsync(0);
    expect(look).toHaveBeenCalledTimes(1);
    p.hide();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(look).toHaveBeenCalledTimes(1);
    p.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(look).toHaveBeenCalledTimes(2);
    expect(p.listeners.size).toBe(0);
    // After coming back, looking carries on as normal until the answer is final.
    look.mockResolvedValue('ready');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await end).toBe('settled');
    expect(look).toHaveBeenCalledTimes(3);
  });

  it('stops while waiting, without one more look, when the caller stops it', async () => {
    const stop = new AbortController();
    const look = vi.fn(async () => 'issuing');
    const end = poll({ look, settled: () => false, delay: () => 5000, budgetMs: 60_000, signal: stop.signal });
    await vi.advanceTimersByTimeAsync(1000);
    stop.abort();
    expect(await end).toBe('stopped');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(look).toHaveBeenCalledTimes(1);
  });

  it('stops while hidden when the caller stops it, and leaves no listener behind', async () => {
    const p = page();
    const stop = new AbortController();
    const end = poll({ look: async () => 1, settled: () => false, delay: () => 10, budgetMs: 60_000, signal: stop.signal, visibility: p.visibility });
    p.hide();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.listeners.size).toBe(1);
    stop.abort();
    expect(await end).toBe('stopped');
    expect(p.listeners.size).toBe(0);
  });

  it('a failing look ends the poll and reaches the caller', async () => {
    const end = poll({ look: async () => { throw new Error('unreachable'); }, settled: () => false, delay: () => 10, budgetMs: 1000 });
    await expect(end).rejects.toThrow('unreachable');
  });
});

describe('backoff', () => {
  it('grows by the factor up to the cap', () => {
    const delay = backoff(2000, 10_000);
    expect([0, 1, 2, 3, 4, 5].map(delay)).toEqual([2000, 3000, 4500, 6750, 10_000, 10_000]);
  });
});

describe('singleFlight', () => {
  it('never runs twice at once, and turns any number of calls during a run into one more run', async () => {
    let running = 0;
    let most = 0;
    let runs = 0;
    const load = singleFlight(async () => {
      running++;
      runs++;
      most = Math.max(most, running);
      await new Promise((done) => setTimeout(done, 100));
      running--;
    });
    const calls = [load(), load(), load(), load()];
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(runs).toBe(2);
    expect(most).toBe(1);
    const later = load();
    await vi.runAllTimersAsync();
    await later;
    expect(runs).toBe(3);
  });
});

describe('shared', () => {
  it('a call made while the load runs joins it instead of sending it again', async () => {
    let runs = 0;
    const load = shared(async () => {
      runs++;
      await new Promise((done) => setTimeout(done, 100));
    });
    const calls = [load(), load(), load()];
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(runs).toBe(1);
    const later = load();
    await vi.runAllTimersAsync();
    await later;
    expect(runs).toBe(2);
  });
});
