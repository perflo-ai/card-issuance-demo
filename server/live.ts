/**
 * Pushes changes to a person's open pages (Server-Sent Events), so a page
 * never asks again and again whether something changed. A webhook from Perflo
 * is what makes something change; this is how the page hears about it.
 *
 * Only ever this person's own pages: a stream is opened with the session
 * cookie, and a message is sent to one Tiny account. Nothing secret goes on a
 * stream: an order as the browser already sees it, or a short "look again".
 *
 * ponytail: one process, kept in memory. A partner running several copies of
 * their backend fans out through their own pub/sub (Redis, Postgres NOTIFY).
 */

import type { Response } from 'express';
import type { LiveMessage } from './views.js';

/** A comment line now and then keeps proxies from closing a quiet stream. Not a request to anyone. */
const KEEPALIVE_MS = 25_000;
/** One person rarely has more pages open than this; more is a script, and is refused. */
const MAX_STREAMS_PER_PERSON = 8;

export class LiveUpdates {
  private readonly streams = new Map<string, Set<Response>>();

  /** Starts a stream for this response. False when the person already has too many open. */
  open(demoUserId: string, res: Response): boolean {
    const mine = this.streams.get(demoUserId) ?? new Set<Response>();
    if (mine.size >= MAX_STREAMS_PER_PERSON) return false;
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Some proxies buffer a response unless told not to; a buffered stream arrives all at once.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    // Tells the browser how long to wait before it opens the stream again after it drops.
    res.write('retry: 3000\n\n');
    mine.add(res);
    this.streams.set(demoUserId, mine);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    keepalive.unref();
    res.on('close', () => {
      clearInterval(keepalive);
      mine.delete(res);
      if (mine.size === 0 && this.streams.get(demoUserId) === mine) this.streams.delete(demoUserId);
    });
    return true;
  }

  send(demoUserId: string, message: LiveMessage): void {
    const mine = this.streams.get(demoUserId);
    if (!mine) return;
    const frame = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of mine) res.write(frame);
  }

  /** Open streams for one person (for tests and the operator). */
  count(demoUserId: string): number {
    return this.streams.get(demoUserId)?.size ?? 0;
  }
}
