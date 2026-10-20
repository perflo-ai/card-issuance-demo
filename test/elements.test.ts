import { describe, expect, it } from 'vitest';
import { elementProblem, EXPIRED_TEXT, isExpired, LOAD_FAILED_TEXT } from '../web/src/elements.js';
import { settleConnection } from '../web/src/connect.js';
import type { LinkStatus } from '../server/views.js';

describe('what the person reads when an element refuses', () => {
  it('a part that did not load gets Tiny’s words, never the words meant for whoever built the page', () => {
    const builderWords = 'This could not load. Check the client secret, and that this website is one of the addresses allowed.';
    expect(elementProblem({ code: 'load_failed', message: builderWords })).toBe(LOAD_FAILED_TEXT);
    expect(elementProblem({ code: 'client_secret_mismatch', message: 'This client_secret is for a sign-in.' })).toBe(LOAD_FAILED_TEXT);
    expect(elementProblem({ code: 'invalid_request', message: 'The field "appearance.theme" is not valid.' })).toBe(LOAD_FAILED_TEXT);
  });

  it('keeps Perflo’s words about what the person did, which say what to do next', () => {
    expect(elementProblem({ code: 'email_invalid', message: 'Enter a valid email address.' })).toBe('Enter a valid email address.');
    expect(elementProblem({ code: 'sign_in_failed', message: 'That code is not right. Check it and try again.' })).toBe(
      'That code is not right. Check it and try again.',
    );
  });

  it('an expired page asks the person to start again, and empty words never reach them', () => {
    const expired = { code: 'session_expired', message: 'This page has expired.' };
    expect(isExpired(expired)).toBe(true);
    expect(elementProblem(expired)).toBe(EXPIRED_TEXT);
    expect(elementProblem({ code: 'code_not_sent', message: '  ' })).toBe('Something went wrong. Try again.');
    // A code that only happens to be an object key is not one of Tiny's.
    expect(elementProblem({ code: 'constructor', message: 'Try again in a moment.' })).toBe('Try again in a moment.');
  });
});

describe('settling a finished sign-in', () => {
  /** Perflo's word did not come in time. */
  const wait = () => Promise.resolve(false);

  it('takes what Tiny already found when it is final, without looking again', async () => {
    let looks = 0;
    const look = () => {
      looks++;
      return Promise.resolve<LinkStatus>('linked');
    };
    expect(await settleConnection('linked', look, wait, new AbortController().signal)).toBe('linked');
    expect(await settleConnection('expired', look, wait, new AbortController().signal)).toBe('expired');
    expect(looks).toBe(0);
  });

  it('still pending: waits, then looks once; a look that fails counts as pending', async () => {
    let looks = 0;
    expect(
      await settleConnection(
        'pending',
        () => {
          looks++;
          return Promise.resolve<LinkStatus>('linked');
        },
        wait,
        new AbortController().signal,
      ),
    ).toBe('linked');
    expect(looks).toBe(1);
    expect(await settleConnection(undefined, () => Promise.reject(new Error('offline')), wait, new AbortController().signal)).toBe(
      'pending',
    );
  });

  it('stopped while waiting: answers null and does not look', async () => {
    const stop = new AbortController();
    let looked = false;
    const settled = settleConnection(
      'pending',
      () => {
        looked = true;
        return Promise.resolve<LinkStatus>('linked');
      },
      (signal) => new Promise((done) => signal.addEventListener('abort', done, { once: true })),
      stop.signal,
    );
    stop.abort();
    expect(await settled).toBeNull();
    expect(looked).toBe(false);
  });
});
