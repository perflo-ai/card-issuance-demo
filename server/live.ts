/**
 * Pushes changes to a person's open pages (Server-Sent Events), so a page
 * never asks again and again whether something changed. A webhook from Perflo
 * is what makes something change; this is how the page hears about it.
 *
 * A stream belongs to the session that opened it, not to the account: it is
 * opened only with the session cookie, closed when that session signs out or
 * is replaced (linking rotates it), and the session is checked again before
 * every write, so a session that ended any other way hears nothing more.
 * Nothing secret goes on a stream: an order as the browser already sees it, or
 * a short "look again".
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

/** True while this session id still opens this account. */
export type SessionCheck = (sessionId: string, demoUserId: string) => boolean;

interface Stream {
  res: Response;
  sessionId: string;
}

export class LiveUpdates {
  private readonly streams = new Map<string, Set<Stream>>();

  constructor(private readonly isCurrent: SessionCheck) {}

  /** Starts a stream for this session. False when the person already has too many open. */
  open(demoUserId: string, sessionId: string, res: Response): boolean {
    const mine = this.streams.get(demoUserId) ?? new Set<Stream>();
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
    const stream: Stream = { res, sessionId };
    mine.add(stream);
    this.streams.set(demoUserId, mine);
    const keepalive = setInterval(() => this.write(demoUserId, stream, ': keepalive\n\n'), KEEPALIVE_MS);
    keepalive.unref();
    res.on('close', () => {
      clearInterval(keepalive);
      mine.delete(stream);
      if (mine.size === 0 && this.streams.get(demoUserId) === mine) this.streams.delete(demoUserId);
    });
    return true;
  }

  send(demoUserId: string, message: LiveMessage): void {
    const mine = this.streams.get(demoUserId);
    if (!mine) return;
    const frame = `data: ${JSON.stringify(message)}\n\n`;
    for (const stream of [...mine]) this.write(demoUserId, stream, frame);
  }

  /** Closes every stream this session opened: it signed out, or linking gave the browser a new one. */
  closeSession(sessionId: string): void {
    for (const mine of this.streams.values()) {
      for (const stream of [...mine]) if (stream.sessionId === sessionId) this.end(mine, stream);
    }
  }

  /** Open streams for one person (for tests and the operator). */
  count(demoUserId: string): number {
    return this.streams.get(demoUserId)?.size ?? 0;
  }

  /** Writes only while the session that opened the stream still opens this account; otherwise closes it. */
  private write(demoUserId: string, stream: Stream, frame: string): void {
    const mine = this.streams.get(demoUserId);
    if (!mine?.has(stream)) return;
    if (!this.isCurrent(stream.sessionId, demoUserId)) {
      this.end(mine, stream);
      return;
    }
    stream.res.write(frame);
  }

  private end(mine: Set<Stream>, stream: Stream): void {
    // Removed now, not on 'close', so nothing more is written to it in between.
    mine.delete(stream);
    stream.res.end();
  }
}
