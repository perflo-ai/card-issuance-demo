/**
 * The server's own log: one JSON object per line on stdout, so a host's log
 * search can filter by field. Every field passes through the one redactor, so
 * a token, a card number or a link capability cannot reach it by mistake.
 *
 * This is the operator's log. The developer log shown in the page is a
 * separate thing (eventLog.ts), kept per person.
 */

import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { redact } from './redact.js';

export type Level = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const at = (level: Level) => (message: string, fields: Record<string, unknown> = {}) =>
    write(JSON.stringify({ time: new Date().toISOString(), level, message, ...(redact(fields) as Record<string, unknown>) }));
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

/** A caller's id is kept only when it looks like one (no log injection), otherwise a new one is made. */
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requestLog(): ties every log line of one request together. */
    requestId?: string;
  }
}

/**
 * One line per finished request, with a request id that is also sent back in
 * X-Request-Id. The path is logged without its query, and the body never is.
 */
export function requestLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.requestId = id;
    res.set('X-Request-Id', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const status = res.statusCode;
      logger[status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info']('request', {
        request_id: id,
        method: req.method,
        // originalUrl: req.path loses the mount prefix when a mounted middleware ends the request.
        path: req.originalUrl.split('?')[0],
        status,
        duration_ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
      });
    });
    next();
  };
}
