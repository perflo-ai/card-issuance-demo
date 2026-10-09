import type { AccountView, CardDetailsView, DemoConfigView, LinkStatus, LogEntry, MeView, Notice, OrderView } from '../../server/views';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const settled = new Set<() => void>();

/**
 * Calls `listener` each time a request to Tiny's server finishes, whatever the
 * outcome. Every line of the developer log is written while the server handles
 * one of these requests, so the log reads new lines only then, instead of on a
 * timer. Reads of the log itself are not reported. Returns an unsubscribe.
 */
export function onRequestSettled(listener: () => void): () => void {
  settled.add(listener);
  return () => settled.delete(listener);
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  try {
    return await send<T>(method, path, body);
  } finally {
    if (!path.startsWith('/demo/events')) for (const listener of settled) listener();
  }
}

async function send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Tiny is not reachable. Check your connection and try again.');
  }
  const json = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!response.ok) {
    throw new ApiError(response.status, json?.error?.message ?? 'Something went wrong. Try again.');
  }
  return json as T;
}

export interface FrameEventPayload {
  type: string;
  frame_session_id: string;
  login_id?: string;
  top_up_id?: string;
  order_id?: string;
  code?: string;
}

export const api = {
  config: () => request<DemoConfigView>('GET', '/demo/config'),
  /** This browser's Tiny account, made on the first visit. */
  session: () => request<{ user: MeView }>('POST', '/demo/session'),
  logout: () => request<{ ok: true }>('POST', '/demo/logout'),
  chat: (text: string) => request<{ reply: string; order?: OrderView }>('POST', '/demo/chat', { text }),
  orders: () => request<{ orders: OrderView[] }>('GET', '/demo/orders'),
  discard: (id: string) => request<{ order: OrderView }>('POST', `/demo/orders/${encodeURIComponent(id)}/discard`),
  advance: (id: string) =>
    request<{ order: OrderView; notice: Notice; linked: boolean }>('POST', `/demo/orders/${encodeURIComponent(id)}/advance`),
  frameEvent: (event: FrameEventPayload) => request<{ link?: LinkStatus }>('POST', '/demo/frame-events', event),
  refreshLink: () => request<{ link: LinkStatus }>('POST', '/demo/link/refresh'),
  account: () => request<{ linked: false } | { linked: true; account: AccountView }>('GET', '/demo/account'),
  limitsLink: () => request<{ frameUrl: string }>('POST', '/demo/limits-link'),
  topUp: (amount?: string) => request<{ frameUrl: string }>('POST', '/demo/top-ups', amount ? { amount } : {}),
  cardDetails: (perfloOrderId: string) =>
    request<{ card: CardDetailsView }>('POST', `/demo/orders/${encodeURIComponent(perfloOrderId)}/card-details`),
  cancelCard: (perfloOrderId: string) =>
    request<{ amountReturned: string; order?: OrderView }>('POST', `/demo/cards/${encodeURIComponent(perfloOrderId)}/cancel`),
  events: (after: number) => request<{ events: LogEntry[] }>('GET', `/demo/events?after=${after}`),
  mockRevoke: () => request<{ ok: true }>('POST', '/demo/mock/revoke-access'),
  mockStopAtCheckout: (on: boolean) => request<{ user: MeView }>('POST', '/demo/mock/stop-at-checkout', { on }),
};
