/**
 * Shapes the browser receives from the demo server. Dependency free, so the
 * web app imports these types directly; perfloApi.ts asserts at compile time
 * that the Perflo shapes still match.
 */

export type DeclineReason = 'over_order_limit' | 'over_monthly_limit' | 'partner_limit' | 'amount_invalid';

export type IdentityStatus = 'not_required' | 'required' | 'pending' | 'approved' | 'rejected';

/** What the browser may see about a revealed card: never the number or the security code. */
export interface CheckoutSummary {
  last4: string;
  expMonth: string;
  expYear: string;
  cardLimit: string;
  filledAt: string;
  /** Mock mode charges the mock merchant; live mode stops at a filled form. */
  outcome: 'charged' | 'filled_not_submitted' | 'charge_refused';
}

export type OrderPhase =
  | 'draft'
  | 'discarded'
  | 'needs_setup'
  | 'placing'
  | 'payment_required'
  | 'login_required'
  | 'identity_check_required'
  | 'issuing'
  | 'ready'
  | 'declined'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed';

/** Everything the browser receives about an order. No tokens, no reveal links, no card numbers. */
export interface OrderView {
  id: string;
  /** When the person asked for it (ISO 8601). */
  createdAt: string;
  perfloOrderId: string | null;
  merchantName: string;
  domain: string;
  amountCents: number;
  description: string;
  phase: OrderPhase;
  /** Perflo frame to embed: the setup or sign-in frame, or the add money frame. */
  frameUrl?: string;
  kycUrl?: string;
  amountDue?: string;
  declineReason?: DeclineReason;
  declineMessage?: string;
  cardLast4?: string;
  cardLimit?: string;
  cardExpiresAt?: string;
  checkout?: CheckoutSummary;
  amountSpent?: string;
  amountReturned?: string;
}

/**
 * The one answer that carries a full card: only when the person asks to see an
 * open card, read fresh through a new single-use reveal link, sent with
 * Cache-Control: no-store, never stored, never logged.
 */
export interface CardDetailsView {
  number: string;
  cvv: string;
  expMonth: string;
  expYear: string;
  holderName: string;
  last4: string;
}

export interface AccountView {
  user_id: string;
  balance: { amount: string; currency: 'USD' };
  limits: {
    per_order: { amount: string; currency: 'USD' };
    per_month: { amount: string; currency: 'USD' };
    spent_this_month: { amount: string; currency: 'USD' };
    remaining_this_month: { amount: string; currency: 'USD' };
  };
  identity_check: { required_above: string; status: IdentityStatus };
  open_cards: Array<{ order_id: string; last4: string; card_limit: string; expires_at: string }>;
}

export interface LogEntry {
  id: number;
  at: string;
  demoUserId: string | null;
  kind: 'api' | 'frame' | 'demo';
  summary: string;
  detail?: unknown;
}

/** The postMessage events a Perflo frame sends (SPEC 8). */
export const FRAME_EVENT_TYPES = [
  'perflo:ready',
  'perflo:login_completed',
  'perflo:limits_saved',
  'perflo:top_up_completed',
  'perflo:setup_completed',
  'perflo:closed',
  'perflo:error',
] as const;

export type LinkStatus = 'linked' | 'login_required' | 'pending' | 'expired';

export type Notice = 'reveal_failed' | 'card_locked' | null;

export interface DemoConfigView {
  mode: 'live' | 'mock';
  perfloOrigin: string;
}

/** The browser's Tiny account. Anonymous: no name or email is ever asked for or shown. */
export interface MeView {
  linked: boolean;
  /** Mock mode test control. */
  stopAtCheckout: boolean;
}
