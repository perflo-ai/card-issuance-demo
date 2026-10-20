import { mkdtempSync } from 'node:fs';
import { createServer, request as httpRequest, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoConfig } from '../server/config.js';
import { EventLog } from '../server/eventLog.js';
import { createLogger } from '../server/logger.js';
import { createMockPerflo, type MockOptions } from '../server/mock/mockPerflo.js';
import { PerfloApi } from '../server/perfloApi.js';
import { DemoService } from '../server/service.js';
import { signatureHeaders } from '../server/signing.js';
import { Store } from '../server/store.js';
import type { LiveMessage } from '../server/views.js';

export const CREDS = {
  partnerId: '3f2b8c1e-5d4a-4b6f-9a7c-1e2d3c4b5a69',
  keyVersion: 'v1',
  secret: 'dGlueS1kZW1vLXNpZ25pbmctdmVjdG9yLXNlY3JldDA',
};
export const PARTNER_ORIGIN = 'https://localhost:5174';
/** The webhook secret tests sign and check with, in the shape Perflo Builder shows. */
export const WEBHOOK_SECRET = 'whsec_dGlueS1kZW1vLXdlYmhvb2stdGVzdC1zZWNyZXQtMDA';
/** Where the test browser says it is (Host header and Origin). */
export const TEST_HOST = 'tiny.test';
export const TEST_ORIGIN = `https://${TEST_HOST}`;

export async function startMock(
  slowIssueMs = 50,
  webhook?: MockOptions['webhook'],
  reuseCards = false,
  now?: () => number,
): Promise<{ base: string; close: () => Promise<void> }> {
  let handler: RequestListener = () => undefined;
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  handler = createMockPerflo({
    ...CREDS,
    selfOrigin: base,
    partnerOrigin: PARTNER_ORIGIN,
    slowIssueMs,
    reuseCards,
    ...(webhook ? { webhook } : {}),
    ...(now ? { now } : {}),
  });
  return { base, close: () => new Promise<void>((done) => server.close(() => done())) };
}

/** The address a fake fetch was called with, whatever form it was given in. */
export function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/**
 * JSON answers in tests are read field by field right after asserting their shape, so they are
 * typed loosely on purpose. Production code validates every answer with zod at the boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseJson = any;

export async function signedFetch(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; token?: string; idem?: string; secret?: string; rawBody?: string } = {},
): Promise<{ status: number; json: LooseJson }> {
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

/** A reveal link read the way a partner must: signed over GET and the link's path, with the person's token. */
export function revealFetch(url: string, token: string | null, secret = CREDS.secret) {
  const parsed = new URL(url);
  const headers: Record<string, string> = signatureHeaders(
    { ...CREDS, secret },
    'GET',
    `${parsed.pathname}${parsed.search}`,
    Buffer.alloc(0),
  );
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { headers });
}

export const sessionOf = (url: string) => new URL(url).searchParams.get('session') as string;

export async function frameCall(base: string, frameUrl: string, action: string, body?: unknown) {
  const headers: Record<string, string> = { 'X-Perflo-Frame-Session': sessionOf(frameUrl) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}/v1/frames/session/${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as LooseJson };
}

/**
 * What a person does in the setup frame: email and code, limits, then (if asked) money, then finish.
 * Tiny sends no email, so the person types it in the frame (the mock's token carries it).
 */
export async function finishSetup(
  base: string,
  frameUrl: string,
  limits = { per_order: '500.00', per_month: '1000.00' },
  email = 'ada@example.com',
) {
  const login = await frameCall(base, frameUrl, 'login', { privy_access_token: `mock-otp:${email}:123456` });
  if (login.status !== 200) throw new Error(`login ${login.status}`);
  const saved = await frameCall(base, frameUrl, 'limits', limits);
  if (saved.status !== 200) throw new Error(`limits ${saved.status}`);
  if (saved.json.next === 'top_up') {
    const state = await frameCall(base, frameUrl, 'state');
    await payInFrame(base, frameUrl, state.json.amount);
  }
  return frameCall(base, frameUrl, 'complete', { step: 'setup' });
}

/** Pays on an add money page. The page is for one amount (`amount`, checked here); none is typed on it. */
export async function payInFrame(base: string, frameUrl: string, amount: string) {
  const topUp = await frameCall(base, frameUrl, 'top-up', {});
  if (topUp.status !== 201) throw new Error(`top-up ${topUp.status} ${JSON.stringify(topUp.json)}`);
  if (topUp.json.amount !== amount) throw new Error(`the page is for ${topUp.json.amount}, not ${amount}`);
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
    listen: { kind: 'local' },
    publicOrigin: TEST_ORIGIN,
    webhookSecret: WEBHOOK_SECRET,
    mockReuseCards: false,
  };
  const log = new EventLog();
  const store = new Store(dataFile);
  const api = new PerfloApi(base, CREDS, log);
  const service = new DemoService(store, api, log, config);
  // The operator's log, kept in memory so tests can read it (and nothing is printed).
  const serverLog: string[] = [];
  const logger = createLogger((line) => serverLog.push(line));
  return { config, log, logger, serverLog, store, api, service, dataFile };
}

export const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A live feed read over a real connection: every message, and whether the server closed it. */
export interface OpenStream {
  messages: LiveMessage[];
  closed: () => boolean;
  close: () => void;
}

/** Opens GET /demo/stream as a browser would (its own cookie), on a server that is really listening. */
export function openStream(base: string, cookie: string, headers: Record<string, string> = {}, query = ''): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const messages: LiveMessage[] = [];
    let ended = false;
    const req = httpRequest(`${base}/demo/stream${query}`, { headers: { Cookie: cookie, ...headers } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`stream ${res.statusCode}`));
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) messages.push(JSON.parse(data.slice('data: '.length)) as LiveMessage);
        }
      });
      res.on('end', () => (ended = true));
      res.on('close', () => (ended = true));
      resolve({ messages, closed: () => ended, close: () => req.destroy() });
    });
    req.on('error', () => undefined);
    req.end();
  });
}
