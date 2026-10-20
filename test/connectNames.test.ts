/**
 * Perflo's connect names, beside the old ones and with the same values: GET /v1/connections/{connection_id}
 * answers like GET /v1/logins/{login_id}, and every answer that carries login_id and login_url also carries
 * connection_id and connect_url. Tiny reads the new names and falls back to the old ones only when a Perflo
 * from before them sent none.
 */
import { describe, expect, it } from 'vitest';
import { EventLog } from '../server/eventLog.js';
import { connectionOf, orderResponse, PerfloApi, PerfloUnavailableError, usersResponse } from '../server/perfloApi.js';
import { CREDS, urlOf } from './helpers.js';

const PAGE = 'https://perflo.test/v1/frames/setup?session=fs_1';
const OTHER_PAGE = 'https://perflo.test/v1/frames/setup?session=fs_2';
const both = { status: 'login_required', login_id: 'lg_1', login_url: PAGE, connection_id: 'lg_1', connect_url: PAGE };
const oldOnly = { status: 'login_required', login_id: 'lg_1', login_url: PAGE };
const newOnly = { status: 'login_required', connection_id: 'lg_1', connect_url: PAGE };

function answering(status: number, body: unknown) {
  const calls: string[] = [];
  const fake: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(urlOf(input)).pathname}`);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { api: new PerfloApi('https://perflo.test', CREDS, new EventLog(), fake), calls };
}

describe('connectionOf: the connection an answer names', () => {
  it('reads connection_id and connect_url when Perflo sends them', () => {
    expect(connectionOf(both)).toEqual({ id: 'lg_1', url: PAGE, connectNames: true });
    expect(connectionOf(newOnly)).toEqual({ id: 'lg_1', url: PAGE, connectNames: true });
    // The new names win over the old ones (the two always carry the same values).
    expect(connectionOf({ ...both, login_url: OTHER_PAGE, login_id: 'lg_2' })).toEqual({ id: 'lg_1', url: PAGE, connectNames: true });
  });

  it('falls back to login_id and login_url from a Perflo from before the connect names', () => {
    expect(connectionOf(oldOnly)).toEqual({ id: 'lg_1', url: PAGE, connectNames: false });
  });

  it('is null when no id or no page to open is named', () => {
    expect(connectionOf({ connect_url: PAGE })).toBeNull();
    expect(connectionOf({ connection_id: 'lg_1' })).toBeNull();
    expect(connectionOf({ connection_id: 'lg_1', connect_url: null, login_url: PAGE })).toBeNull();
  });
});

describe('answers that name a connection', () => {
  it('POST /v1/users 202 is accepted with the new names, the old ones, or both', () => {
    const expires = { expires_at: '2026-10-20T12:30:00.000Z' };
    expect(usersResponse.safeParse({ ...both, ...expires }).success).toBe(true);
    expect(usersResponse.safeParse({ ...oldOnly, ...expires }).success).toBe(true);
    expect(usersResponse.safeParse({ ...newOnly, ...expires }).success).toBe(true);
  });

  it('an answer with no id or no page to open is refused, whichever names it uses', () => {
    const expires = { expires_at: '2026-10-20T12:30:00.000Z' };
    expect(usersResponse.safeParse({ status: 'login_required', connect_url: PAGE, ...expires }).success).toBe(false);
    expect(usersResponse.safeParse({ status: 'login_required', connection_id: 'lg_1', ...expires }).success).toBe(false);
    expect(orderResponse.safeParse({ order_id: 'ord_1', status: 'login_required', connection_id: 'lg_1', connect_url: null }).success).toBe(
      false,
    );
    expect(orderResponse.safeParse({ order_id: 'ord_1', status: 'login_required' }).success).toBe(false);
  });

  it('a connect page link that is not https is refused like any other link', () => {
    expect(orderResponse.safeParse({ order_id: 'ord_1', ...both, connect_url: 'javascript:alert(1)' }).success).toBe(false);
    expect(orderResponse.safeParse({ order_id: 'ord_1', ...both, connect_url: 'http://perflo.example/x' }).success).toBe(false);
  });

  it('an order waiting on a connection keeps both pairs when stored and read back', () => {
    const parsed = orderResponse.parse({ order_id: 'ord_1', one_time: true, ...both, client_secret: 'fs_1' });
    expect(orderResponse.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(parsed).toMatchObject({ connection_id: 'lg_1', connect_url: PAGE, login_id: 'lg_1', login_url: PAGE });
  });

  it('createUser refuses a 202 that names no connection as outside the contract', async () => {
    const { api } = answering(202, { status: 'login_required', expires_at: '2026-10-20T12:30:00.000Z' });
    await expect(api.createUser('u1', { external_user_id: 'u1' })).rejects.toBeInstanceOf(PerfloUnavailableError);
  });
});

describe('getConnection: asked where Perflo named it', () => {
  it('at GET /v1/connections/{id} when Perflo sent connection_id', async () => {
    const { api, calls } = answering(200, { status: 'pending' });
    expect(await api.getConnection('u1', { id: 'lg_1', connectNames: true })).toEqual({ status: 'pending' });
    expect(calls).toEqual(['GET /v1/connections/lg_1']);
  });

  it('at GET /v1/logins/{id} when it did not (a Perflo from before the connect names)', async () => {
    const { api, calls } = answering(200, { status: 'approved', user_id: 'usr_1', user_access_token: 'ptk_test_x' });
    expect(await api.getConnection('u1', { id: 'lg_1', connectNames: false })).toEqual({
      status: 'approved',
      user_id: 'usr_1',
      user_access_token: 'ptk_test_x',
    });
    expect(calls).toEqual(['GET /v1/logins/lg_1']);
  });
});
