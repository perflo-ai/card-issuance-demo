/**
 * Perflo's connections: a user who still has to connect, or reconnect, is answered `connection_required`
 * with connection_id and connect_url, and the connection is checked at GET /v1/connections/{connection_id}.
 * Perflo sends no login names any more, and Tiny reads none.
 */
import { describe, expect, it } from 'vitest';
import { EventLog } from '../server/eventLog.js';
import { orderResponse, PerfloApi, PerfloUnavailableError, usersResponse } from '../server/perfloApi.js';
import { CREDS, urlOf } from './helpers.js';

const PAGE = 'https://perflo.test/v1/frames/setup?session=fs_1';
const waiting = { status: 'connection_required', connection_id: 'lg_1', connect_url: PAGE };
const expires = { expires_at: '2026-10-20T12:30:00.000Z' };

function answering(status: number, body: unknown) {
  const calls: string[] = [];
  const fake: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(urlOf(input)).pathname}`);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { api: new PerfloApi('https://perflo.test', CREDS, new EventLog(), fake), calls };
}

describe('answers that name a connection', () => {
  it('POST /v1/users 202 and an order are read as connection_required with connection_id and connect_url', () => {
    expect(usersResponse.parse({ ...waiting, ...expires, client_secret: 'fs_1' })).toEqual({
      ...waiting,
      ...expires,
      client_secret: 'fs_1',
    });
    expect(orderResponse.parse({ order_id: 'ord_1', one_time: true, ...waiting, client_secret: null })).toEqual({
      order_id: 'ord_1',
      one_time: true,
      ...waiting,
      client_secret: null,
    });
  });

  it('the login names are not read: login_required, login_id and login_url are outside the contract', () => {
    const old = { status: 'login_required', login_id: 'lg_1', login_url: PAGE };
    expect(usersResponse.safeParse({ ...old, ...expires }).success).toBe(false);
    expect(orderResponse.safeParse({ order_id: 'ord_1', ...old }).success).toBe(false);
    expect(orderResponse.safeParse({ order_id: 'ord_1', status: 'connection_required', login_id: 'lg_1', login_url: PAGE }).success).toBe(
      false,
    );
    // Sent beside the new names, the old ones are dropped, never kept.
    expect(orderResponse.parse({ order_id: 'ord_1', ...waiting, login_id: 'lg_1', login_url: PAGE })).toEqual({
      order_id: 'ord_1',
      ...waiting,
    });
  });

  it('an answer with no id or no page to open is refused', () => {
    expect(usersResponse.safeParse({ status: 'connection_required', connect_url: PAGE, ...expires }).success).toBe(false);
    expect(usersResponse.safeParse({ status: 'connection_required', connection_id: 'lg_1', ...expires }).success).toBe(false);
    expect(
      orderResponse.safeParse({ order_id: 'ord_1', status: 'connection_required', connection_id: 'lg_1', connect_url: null }).success,
    ).toBe(false);
    expect(orderResponse.safeParse({ order_id: 'ord_1', status: 'connection_required' }).success).toBe(false);
  });

  it('a connect page link that is not https is refused like any other link', () => {
    expect(orderResponse.safeParse({ order_id: 'ord_1', ...waiting, connect_url: 'javascript:alert(1)' }).success).toBe(false);
    expect(orderResponse.safeParse({ order_id: 'ord_1', ...waiting, connect_url: 'http://perflo.example/x' }).success).toBe(false);
  });

  it('createUser refuses a 202 that names no connection as outside the contract', async () => {
    const { api } = answering(202, { status: 'connection_required', ...expires });
    await expect(api.createUser('u1', { external_user_id: 'u1' })).rejects.toBeInstanceOf(PerfloUnavailableError);
  });
});

describe('getConnection', () => {
  it('asks at GET /v1/connections/{connection_id}', async () => {
    const { api, calls } = answering(200, { status: 'approved', user_id: 'usr_1', user_access_token: 'ptk_test_x' });
    expect(await api.getConnection('u1', 'lg_1')).toEqual({ status: 'approved', user_id: 'usr_1', user_access_token: 'ptk_test_x' });
    expect(calls).toEqual(['GET /v1/connections/lg_1']);
  });
});
