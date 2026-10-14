import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSION_ID_PATTERN, Store, StoreError } from '../server/store.js';

const fileIn = (name: string) => join(mkdtempSync(join(tmpdir(), `tiny-store-${name}-`)), 's.json');
/** The file's inode changes on every write (temp file renamed over it). */
const writes = (file: string) => statSync(file).ino;
const intent = { merchantName: 'Amazon', domain: 'amazon.com', amountCents: 2000, description: 'books' };

describe('lookups only ever find what Tiny stored', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', ''])('session id %j opens nothing', (key) => {
    const store = new Store(fileIn('proto'));
    store.createUser();
    expect(store.userForSession(key)).toBeNull();
    expect(store.rotateSession(key)).toBeNull();
    store.endSession(key);
    expect(() => store.user(key)).toThrow('unknown demo user');
    expect(store.order('x', key)).toBeNull();
    // Nothing was written onto shared prototypes.
    expect(({} as Record<string, unknown>).expiresAt).toBeUndefined();
    expect(({} as Record<string, unknown>).userId).toBeUndefined();
  });

  it('a data file with __proto__ keys loads as plain records and pollutes nothing', () => {
    const file = fileIn('proto-file');
    writeFileSync(file, '{"sessions":{"__proto__":{"userId":"x","expiresAt":99999999999999}},"users":{},"orders":{}}');
    const store = new Store(file);
    expect(store.userForSession('__proto__')).toBeNull();
    expect(({} as Record<string, unknown>).userId).toBeUndefined();
  });

  it('only ids of the shape Tiny makes are looked up', () => {
    const store = new Store(fileIn('shape'));
    const { sessionId } = store.createUser();
    expect(SESSION_ID_PATTERN.test(sessionId)).toBe(true);
    expect(store.userForSession(sessionId)).not.toBeNull();
    expect(store.userForSession(`${sessionId} `)).toBeNull();
    expect(store.userForSession(sessionId.slice(1))).toBeNull();
  });
});

describe('a bad data file fails closed', () => {
  const bad: Array<[string, string]> = [
    ['not JSON', '{"sessions": '],
    ['the wrong top level', '[]'],
    [
      'a user with no perflo field (would have read as linked)',
      JSON.stringify({ sessions: {}, users: { u1: { id: 'u1', createdAt: '2026-10-09T00:00:00Z', pendingLogin: null } }, orders: {} }),
    ],
    [
      'a session with no expiry and no legacy shape',
      JSON.stringify({ sessions: { ['a'.repeat(43)]: { userId: 'u1' } }, users: {}, orders: {} }),
    ],
    [
      'a user filed under another id',
      JSON.stringify({
        sessions: {},
        users: { u2: { id: 'u1', createdAt: '2026-10-09T00:00:00Z', perflo: null, pendingLogin: null } },
        orders: {},
      }),
    ],
    ['an unknown field', JSON.stringify({ sessions: {}, users: {}, orders: {}, admin: true })],
    [
      'an order with a negative amount',
      JSON.stringify({
        sessions: {},
        users: {},
        orders: {
          o1: {
            id: 'o1',
            demoUserId: 'u1',
            idempotencyKey: 'k',
            intent: { ...intent, amountCents: -5 },
            state: 'draft',
            perfloOrderId: null,
            last: null,
            revealUsed: false,
            checkout: null,
            amountReturned: null,
            createdAt: '2026-10-09T00:00:00Z',
          },
        },
      }),
    ],
  ];
  it.each(bad)('refuses to open %s, without echoing the content', (_label, content) => {
    const file = fileIn('bad');
    writeFileSync(file, content);
    const failure = (() => {
      try {
        new Store(file);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(StoreError);
    expect((failure as Error).message).toContain(file);
    // The file is left exactly as it was, for the operator to look at.
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  it('starts empty only when there is no file yet, and says so', () => {
    const file = fileIn('missing');
    const store = new Store(file);
    expect(store.loadedFromFile).toBe(false);
    expect(() => statSync(file)).toThrow();
    store.createUser();
    expect(new Store(file).loadedFromFile).toBe(true);
  });

  it('drops sessions that expired or belong to nobody when the file opens', () => {
    const file = fileIn('expired');
    const user = { id: 'u1', createdAt: '2026-10-09T00:00:00Z', perflo: null, pendingLogin: null };
    const [live, old, orphan] = ['a', 'b', 'c'].map((c) => c.repeat(43));
    writeFileSync(
      file,
      JSON.stringify({
        sessions: {
          [live]: { userId: 'u1', expiresAt: Date.now() + 60_000 },
          [old]: { userId: 'u1', expiresAt: Date.now() - 1 },
          [orphan]: { userId: 'gone', expiresAt: Date.now() + 60_000 },
        },
        users: { u1: user },
        orders: {},
      }),
    );
    const store = new Store(file);
    expect(store.userForSession(live)?.id).toBe('u1');
    expect(store.userForSession(old)).toBeNull();
    expect(store.userForSession(orphan)).toBeNull();
  });
});

describe('writes happen only on real changes', () => {
  it('reading, and looking up unknown or garbage sessions, writes nothing', () => {
    const file = fileIn('reads');
    const store = new Store(file);
    const { user, sessionId } = store.createUser();
    const before = writes(file);
    for (let i = 0; i < 50; i++) {
      store.userForSession(sessionId);
      store.userForSession('z'.repeat(43));
      store.userForSession('__proto__');
      store.ordersFor(user.id);
      store.endSession('y'.repeat(43));
    }
    expect(writes(file)).toBe(before);
  });

  it('an update that changes nothing (a status read with the same answer) writes nothing', () => {
    const file = fileIn('same');
    const store = new Store(file);
    const { user } = store.createUser();
    const order = store.createOrder(user.id, intent);
    store.updateOrder(order, (o) => (o.last = { order_id: 'ord_1', status: 'issuing' }));
    const before = writes(file);
    for (let i = 0; i < 20; i++) store.updateOrder(order, (o) => (o.last = { order_id: 'ord_1', status: 'issuing' }));
    expect(writes(file)).toBe(before);
    store.updateOrder(order, (o) => (o.last = { order_id: 'ord_1', status: 'cancelled' }));
    expect(writes(file)).not.toBe(before);
  });

  it('opening an up-to-date file does not rewrite it', () => {
    const file = fileIn('open');
    new Store(file).createUser();
    const before = writes(file);
    new Store(file);
    expect(writes(file)).toBe(before);
  });

  it('writes owner-only, and every write is the whole valid store (it opens again)', () => {
    const file = fileIn('mode');
    const store = new Store(file);
    const { user, sessionId } = store.createUser();
    store.createOrder(user.id, intent);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = new Store(file);
    expect(again.userForSession(sessionId)?.id).toBe(user.id);
    expect(again.ordersFor(user.id)).toHaveLength(1);
  });

  it('refuses to update an order it did not hand out', () => {
    const store = new Store(fileIn('foreign'));
    const { user } = store.createUser();
    const order = store.createOrder(user.id, intent);
    expect(() => store.updateOrder({ ...order }, () => undefined)).toThrow('unknown demo order');
  });
});

describe('the chosen look', () => {
  it('is kept on the account and fixed on each order when it is made, across a restart', () => {
    const file = fileIn('look');
    const store = new Store(file);
    const { user } = store.createUser();
    const plain = store.createOrder(user.id, intent);
    store.updateUser(user.id, (u) => (u.look = 'night'));
    const dark = store.createOrder(user.id, intent);
    store.updateUser(user.id, (u) => (u.look = 'flat'));
    const reopened = new Store(file);
    expect(reopened.user(user.id).look).toBe('flat');
    expect(reopened.order(user.id, plain.id)?.look).toBeUndefined();
    expect(reopened.order(user.id, dark.id)?.look).toBe('night');
  });

  it('a look that is not one of Tiny’s stops the server rather than being sent', () => {
    const file = fileIn('look-bad');
    writeFileSync(
      file,
      JSON.stringify({
        sessions: {},
        users: { u1: { id: 'u1', createdAt: '2026-10-09T00:00:00Z', perflo: null, pendingLogin: null, look: 'neon' } },
        orders: {},
      }),
    );
    expect(() => new Store(file)).toThrow(StoreError);
  });
});
