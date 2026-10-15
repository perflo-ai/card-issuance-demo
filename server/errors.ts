/**
 * What the browser is told when a request fails. Every message is plain and
 * says what to do next; nothing internal (stack, provider text, codes) is ever
 * sent. Payments' own messages are written to be shown to people as they are
 * (each code in PARTNER_ERROR_CODES), so those pass through; anything that
 * means Tiny itself is misconfigured or sent a bad request gets a generic line
 * for the person and a note for the operator's log.
 */

import { PerfloApiError, PerfloUnavailableError, type PartnerErrorCode } from './perfloApi.js';
import { DemoError } from './service.js';

/** A refusal decided by Tiny's own routes. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface BrowserError {
  status: number;
  message: string;
  /** For the server log only: why this happened, when the operator has something to fix. */
  operatorNote?: string;
  /** Payments' own Retry-After, passed on so the browser waits as long as it was asked to. */
  retryAfterSeconds?: number;
}

const TRY_AGAIN = 'Payments could not do that right now. Try again in a few minutes.';

/** How each documented payments code reaches the browser. */
const PAYMENTS: Record<PartnerErrorCode, { status: number; message?: string; operatorNote?: string }> = {
  // The person: their access ended. The service drops the token and starts setup again on the next try.
  user_token_invalid: { status: 409, message: 'Payments need to be set up again. Send your request once more.' },
  user_not_connected: { status: 409 },
  // Tiny itself: wrong partner id, key version or secret, or this server's clock is off by more than 2 minutes.
  unauthorized: {
    status: 502,
    message: TRY_AGAIN,
    operatorNote: 'payments refused the partner signature: check PARTNER_ID, PARTNER_KEY_VERSION, PARTNER_SECRET and the clock',
  },
  invalid_request: { status: 502, message: TRY_AGAIN, operatorNote: 'payments refused a request Tiny built: a bug in Tiny' },
  unsupported_media_type: { status: 502, message: TRY_AGAIN, operatorNote: 'payments refused the body type: a bug in Tiny' },
  request_too_large: { status: 502, message: TRY_AGAIN, operatorNote: 'payments refused the body size: a bug in Tiny' },
  idempotency_key_required: { status: 502, message: TRY_AGAIN, operatorNote: 'a write was sent without an Idempotency-Key: a bug in Tiny' },
  idempotency_key_reused: {
    status: 502,
    message: TRY_AGAIN,
    operatorNote: 'an Idempotency-Key was reused for a different body: a bug in Tiny',
  },
  // Waits and limits: say so, and when to try again.
  rate_limited: { status: 429 },
  code_send_limited: { status: 429 },
  idempotency_in_progress: { status: 409 },
  order_in_progress: { status: 409 },
  service_unavailable: { status: 503 },
  internal_error: { status: 502 },
  // The thing asked for cannot be done; the message says why.
  not_found: { status: 404 },
  conflict: { status: 409 },
  card_not_open: { status: 409 },
  order_not_cancellable: { status: 409 },
  email_missing: { status: 409 },
  wrong_person: { status: 409 },
  frame_expired: { status: 410 },
  frame_step_invalid: { status: 409 },
  sign_in_failed: { status: 409 },
  amount_invalid: { status: 400 },
  // Tiny always sends the amount the person typed, so this means Tiny left it out.
  amount_required: { status: 502, message: TRY_AGAIN, operatorNote: 'payments asked for an amount Tiny did not send: a bug in Tiny' },
  limits_invalid: { status: 400 },
};

export function toBrowserError(error: unknown): BrowserError {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (error instanceof DemoError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'bad_request' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof PerfloUnavailableError) {
    return { status: 503, message: 'Payments are not reachable right now. Try again in a moment.', operatorNote: error.message };
  }
  if (error instanceof PerfloApiError) {
    const known = Object.hasOwn(PAYMENTS, error.code) ? PAYMENTS[error.code as PartnerErrorCode] : null;
    if (!known) {
      return { status: 502, message: TRY_AGAIN, operatorNote: `payments answered an undocumented code (HTTP ${error.httpStatus})` };
    }
    return {
      status: known.status,
      message: known.message ?? error.message,
      ...(known.operatorNote ? { operatorNote: known.operatorNote } : {}),
      ...(error.retryAfterSeconds !== null ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    };
  }
  // express.json(): a body that is not JSON, or too large.
  const parserStatus = (error as { status?: unknown; type?: unknown } | null)?.status;
  if (parserStatus === 413) return { status: 413, message: 'This request is too large.' };
  if (error instanceof SyntaxError || parserStatus === 400) return { status: 400, message: 'The request could not be read.' };
  return {
    status: 500,
    message: 'Something went wrong. Try again.',
    operatorNote: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
  };
}
