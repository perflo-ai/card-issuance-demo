/**
 * The one redactor. Everything that reaches the event log or stdout passes
 * through it. Tokens, card data and secrets are replaced outright; URLs that
 * carry a capability in their query (login_url, frame_url, kyc_url) keep only
 * origin and path; emails are masked.
 */

const DROP_KEYS = new Set([
  'user_access_token',
  'authorization',
  'card_number',
  'cvv',
  'exp_month',
  'exp_year',
  'secret',
  'partner_secret',
  'reveal_url',
  'client_secret',
  'privy_access_token',
  'x-partner-signature',
  'token',
  // The frame's session id is the capability its own actions use: never kept in the log.
  'frame_session_id',
]);

const URL_KEY = /_url$/;

export function stripQuery(value: string): string {
  try {
    const url = new URL(value);
    return url.search || url.hash ? `${url.origin}${url.pathname}?[redacted]` : `${url.origin}${url.pathname}`;
  } catch {
    return '[redacted]';
  }
}

export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at < 1) return '[redacted]';
  return `${value[0]}***${value.slice(at)}`;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (DROP_KEYS.has(lower)) {
      out[key] = '[redacted]';
    } else if (URL_KEY.test(lower) && typeof inner === 'string') {
      out[key] = stripQuery(inner);
    } else if (lower === 'email' && typeof inner === 'string') {
      out[key] = maskEmail(inner);
    } else {
      out[key] = redact(inner, depth + 1);
    }
  }
  return out;
}
