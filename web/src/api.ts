import type {
  AccountView,
  CardDetailsView,
  DemoConfigView,
  LinkStatus,
  LogEntry,
  LookId,
  MeView,
  Notice,
  OrderView,
  ConnectView,
} from '../../server/views';

/** A page link answer: the link, and the client_secret Perflo.js opens it with when Perflo sent one. */
type PageLink = { frameUrl: string; clientSecret?: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** How long the server asked us to wait before trying again (Retry-After), when it said. */
    readonly retryAfterMs: number | null = null,
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
    const retryAfter = response.headers.get('retry-after');
    throw new ApiError(
      response.status,
      json?.error?.message ?? 'Something went wrong. Try again.',
      retryAfter !== null && /^[0-9]{1,4}$/.test(retryAfter) ? Number(retryAfter) * 1000 : null,
    );
  }
  return json as T;
}

export interface FrameEventPayload {
  type: string;
  frame_session_id: string;
  connection_id?: string;
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
  limitsLink: () => request<PageLink>('POST', '/demo/limits-link'),
  /** Perflo's add money page for exactly `amount`, the amount typed in Tiny ("10.00"), and the amount Perflo says it is for. */
  topUp: (amount: string) => request<PageLink & { amount: string }>('POST', '/demo/top-ups', { amount }),
  /** Only the look's id goes to Tiny's server; what Perflo is sent for it is decided there. */
  look: (look: LookId) => request<{ user: MeView }>('POST', '/demo/look', { look }),
  connect: () => request<ConnectView>('POST', '/demo/connect'),
  cardDetails: (perfloOrderId: string) =>
    request<{ card: CardDetailsView }>('POST', `/demo/orders/${encodeURIComponent(perfloOrderId)}/card-details`),
  cancelCard: (perfloOrderId: string) =>
    request<{ amountReturned: string | null; order?: OrderView }>('POST', `/demo/cards/${encodeURIComponent(perfloOrderId)}/cancel`),
  events: (after: number) => request<{ events: LogEntry[] }>('GET', `/demo/events?after=${after}`),
  mockRevoke: () => request<{ ok: true }>('POST', '/demo/mock/revoke-access'),
  mockStopAtCheckout: (on: boolean) => request<{ user: MeView }>('POST', '/demo/mock/stop-at-checkout', { on }),
};
