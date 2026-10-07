import { mkdtempSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoConfig } from '../server/config.js';
import { EventLog } from '../server/eventLog.js';
import { createMockPerflo } from '../server/mock/mockPerflo.js';
import { PerfloApi } from '../server/perfloApi.js';
import { DemoService } from '../server/service.js';
import { signatureHeaders } from '../server/signing.js';
import { Store } from '../server/store.js';

export const CREDS = {
  partnerId: '3f2b8c1e-5d4a-4b6f-9a7c-1e2d3c4b5a69',
  keyVersion: 'v1',
  secret: 'dGlueS1kZW1vLXNpZ25pbmctdmVjdG9yLXNlY3JldDA',
};
export const PARTNER_ORIGIN = 'https://localhost:5174';

export async function startMock(slowIssueMs = 50): Promise<{ base: string; close: () => Promise<void> }> {
  let handler: RequestListener = () => undefined;
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  handler = createMockPerflo({ ...CREDS, selfOrigin: base, partnerOrigin: PARTNER_ORIGIN, slowIssueMs });
  return { base, close: () => new Promise<void>((done) => server.close(() => done())) };
}

export async function signedFetch(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; token?: string; idem?: string; secret?: string; rawBody?: string } = {},
): Promise<{ status: number; json: any }> {
  const raw = options.rawBody ?? (options.body === undefined ? '' : JSON.stringify(options.body));
  const bytes = Buffer.from(raw, 'utf8');
  const headers: Record<string, string> = {
    ...signatureHeaders({ ...CREDS, secret: options.secret ?? CREDS.secret }, method, path, bytes),
  };
  if (raw) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.idem) headers['Idempotency-Key'] = options.idem;
  const response = await fetch(base + path, { method, headers, body: raw ? bytes : undefined });
  return { status: response.status, json: await response.json().catch(() => null) };
}

export const sessionOf = (url: string) => new URL(url).searchParams.get('session') as string;

export async function frameCall(base: string, frameUrl: string, action: string, body?: unknown) {
  const response = await fetch(`${base}/partner/v2/frames/${sessionOf(frameUrl)}/${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
}

/** What a person does in the setup frame: code, limits, then (if asked) money, then finish. */
export async function finishSetup(base: string, frameUrl: string, limits = { per_order: '500.00', per_month: '1000.00' }) {
  const login = await frameCall(base, frameUrl, 'login', { privy_access_token: 'mock-otp:123456' });
  if (login.status !== 200) throw new Error(`login ${login.status}`);
  const saved = await frameCall(base, frameUrl, 'limits', limits);
  if (saved.status !== 200) throw new Error(`limits ${saved.status}`);
  if (saved.json.next === 'top_up') {
    const state = await frameCall(base, frameUrl, 'state');
    await payInFrame(base, frameUrl, state.json.amount);
  }
  return frameCall(base, frameUrl, 'complete', { step: 'setup' });
}

export async function payInFrame(base: string, frameUrl: string, amount: string) {
  const topUp = await frameCall(base, frameUrl, 'top-up', { amount });
  if (topUp.status !== 201) throw new Error(`top-up ${topUp.status} ${JSON.stringify(topUp.json)}`);
  const paid = await fetch(`${base}/mock-stripe/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_secret: topUp.json.client_secret }),
  });
  if (!paid.ok) throw new Error('mock stripe refused');
  return frameCall(base, frameUrl, 'complete', { step: 'top_up' });
}

export function makeDemo(base: string, mode: 'mock' | 'live' = 'mock') {
  const dataFile = join(mkdtempSync(join(tmpdir(), 'tiny-demo-')), 'store.json');
  const config: DemoConfig = {
    mode,
    perfloApiBase: base,
    perfloOrigin: new URL(base).origin,
    credentials: CREDS,
    dataFile,
  };
  const log = new EventLog();
  const store = new Store(dataFile);
  const api = new PerfloApi(base, CREDS, log);
  const service = new DemoService(store, api, log, config);
  return { config, log, store, api, service, dataFile };
}

export const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
