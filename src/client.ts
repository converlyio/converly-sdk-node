/**
 * The Converly client factory and the `completeSignup` implementation.
 */

import { ConverlyConfigError, ConverlyValidationError } from './errors';
import { readCorrelation } from './correlation';
import { signRequest } from './signing';
import { sendSigned } from './http';
import { VERSION } from './version';
import type {
  CompleteSignupInput,
  CompleteSignupResult,
  ConverlyClient,
  CreateClientOptions,
  FetchLike,
} from './types';

const DEFAULT_API_BASE = 'https://api.converly.io';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CUSTOMER_EVENT_ID_LEN = 200;

/**
 * Mirrors the server's publish-time trigger id rule: URL-safe ASCII, 1–64
 * chars. A triggerKey outside this alphabet can never match a published flow
 * (the dashboard cannot publish one), so rejecting it at createClient() turns
 * a silent "every request returns no_matching_flows" into an immediate,
 * fixable config error.
 */
const TRIGGER_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Mirrors the server's correlation-token schema: 16–64 hex chars. Real
 * loader-issued tokens are always 64 hex. Anything else is a corrupted or
 * tampered cookie — treated as "no token" (see {@link normalizeToken}).
 */
const CORRELATION_TOKEN_RE = /^[a-f0-9]{16,64}$/i;

/**
 * Light email sanity check — deliberately LOOSER than the server's validator,
 * so it only rejects values that are unambiguously not an email address (which
 * would 400 server-side and lose the whole conversion).
 */
const EMAIL_SANITY_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create a configured Converly client.
 *
 * Validates its options synchronously — a missing/short `webhookSecret`, a
 * missing `siteKey`, a `triggerKey` that could never match a published flow,
 * or no available `fetch` throws {@link ConverlyConfigError} immediately,
 * before any request.
 *
 * @throws {ConverlyConfigError} when an option is missing or invalid.
 * @example
 * import { createClient } from '@converly/sdk-node';
 *
 * const converly = createClient({
 *   siteKey:       process.env.CONVERLY_SITE_KEY!,
 *   triggerKey:    'main-signup',
 *   webhookSecret: process.env.CONVERLY_WEBHOOK_SECRET!,
 *   // apiBase, fetch, timeoutMs, userAgent are optional
 * });
 */
export function createClient(options: CreateClientOptions): ConverlyClient {
  const opts = (options ?? {}) as CreateClientOptions;

  if (typeof opts.siteKey !== 'string' || opts.siteKey.length === 0) {
    throw new ConverlyConfigError(
      'siteKey is required (non-empty string). Use your public site identifier — the same value as the ' +
        "loader's ?key= / data-site-key. It is not a secret.",
    );
  }
  if (typeof opts.triggerKey !== 'string' || !TRIGGER_KEY_RE.test(opts.triggerKey)) {
    throw new ConverlyConfigError(
      'triggerKey is required and must be 1–64 URL-safe ASCII characters (letters, digits, "_", "-"), ' +
        'e.g. "main-signup". This matches the rule the Converly dashboard applies when publishing a ' +
        'flow — any other value could never match a published flow.',
    );
  }
  if (typeof opts.webhookSecret !== 'string' || opts.webhookSecret.length < 32) {
    throw new ConverlyConfigError(
      'webhookSecret is required and must be at least 32 characters. Copy it from your Converly ' +
        'dashboard, read it from an env var, and keep it server-side. It is environment-specific — a ' +
        'staging secret cannot sign production requests.',
    );
  }

  const fetchImpl: FetchLike | undefined =
    opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') {
    throw new ConverlyConfigError(
      'No fetch implementation available. Run on Node 18+ (which provides a global fetch) or pass one via ' +
        'the `fetch` option (e.g. undici or node-fetch).',
    );
  }

  const apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? `@converly/sdk-node/${VERSION}`;

  // Path segments are percent-encoded, and the SAME encoded path is both
  // signed and requested — so the server's `req.path` matches the signing
  // string byte-for-byte.
  const webhookPath = `/api/webhook-bridge/saas-signup/${encodeURIComponent(
    opts.siteKey,
  )}/${encodeURIComponent(opts.triggerKey)}`;
  const webhookUrl = apiBase + webhookPath;
  const webhookSecret = opts.webhookSecret;

  return {
    readCorrelation,
    completeSignup(input: CompleteSignupInput): Promise<CompleteSignupResult> {
      return completeSignup({
        input,
        webhookUrl,
        webhookPath,
        webhookSecret,
        fetchImpl,
        timeoutMs,
        userAgent,
      });
    },
  };
}

interface CompleteSignupContext {
  input: CompleteSignupInput;
  webhookUrl: string;
  webhookPath: string;
  webhookSecret: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  userAgent: string;
}

async function completeSignup(ctx: CompleteSignupContext): Promise<CompleteSignupResult> {
  const input = ctx.input;
  validateInput(input);

  const { token, invalid } = normalizeToken(input.correlation_token);
  const allowUncorrelated = input.allow_uncorrelated === true;

  // Default no-op: a null (or unusable) token without opt-in fires nothing
  // and sends no request. This is the common, correct outcome for
  // admin-created accounts, backfills, and SSO users who never hit the
  // marketing site. A malformed token is reported distinctly so integration
  // bugs (passing the wrong value) stay visible in the caller's logs.
  if (token === null && !allowUncorrelated) {
    return {
      status: 'skipped_uncorrelated',
      fired: false,
      reason: invalid ? 'invalid_correlation_token' : 'no_correlation_token',
      customer_event_id: input.customer_event_id,
    };
  }

  // Serialize ONCE. This exact string is both signed and sent as the body —
  // never re-serialized. Optional fields are explicitly null-filled (and
  // blank strings normalized to null — the server rejects empty-string PII)
  // so the wire shape is stable regardless of what the caller supplied.
  const rawBody = JSON.stringify({
    correlation_token: token,
    customer_event_id: input.customer_event_id,
    email: normalizePii(input.email),
    phone: normalizePii(input.phone),
    first_name: normalizePii(input.first_name),
    last_name: normalizePii(input.last_name),
  });

  const parsed = await sendSigned({
    url: ctx.webhookUrl,
    // Signed at the start of EVERY attempt, so retries carry a fresh
    // timestamp and can never drift outside the server's ±5-minute
    // signature-freshness window (which a long timeoutMs plus backoff
    // could otherwise exceed).
    getHeaders: () => {
      const { header } = signRequest({
        timestamp: Math.floor(Date.now() / 1000),
        method: 'POST',
        path: ctx.webhookPath,
        rawBody,
        secret: ctx.webhookSecret,
      });
      return {
        'Content-Type': 'application/json',
        'X-Converly-Signature': header,
        'User-Agent': ctx.userAgent,
      };
    },
    rawBody,
    fetchImpl: ctx.fetchImpl,
    timeoutMs: ctx.timeoutMs,
  });

  return mapResult(parsed, input.customer_event_id);
}

/**
 * Normalize a correlation token. Null/empty/whitespace-only → no token.
 * A non-empty value that does not look like a loader-issued token (16–64 hex
 * chars — the only shape the server accepts) is a corrupted or tampered
 * cookie: also treated as "no token", but flagged `invalid` so the skip
 * result can report it distinctly. Sending it through would 400 server-side
 * and turn a recoverable situation into a lost conversion.
 */
function normalizeToken(token: string | null | undefined): {
  token: string | null;
  invalid: boolean;
} {
  if (typeof token !== 'string') return { token: null, invalid: false };
  const trimmed = token.trim();
  if (trimmed.length === 0) return { token: null, invalid: false };
  if (!CORRELATION_TOKEN_RE.test(trimmed)) return { token: null, invalid: true };
  return { token: trimmed, invalid: false };
}

/** Trim a PII field; blank/whitespace-only (or nullish) becomes null. */
function normalizePii(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validateInput(input: CompleteSignupInput): void {
  if (input == null || typeof input !== 'object') {
    throw new ConverlyValidationError(
      'completeSignup requires a payload object, e.g. { correlation_token, customer_event_id }.',
    );
  }
  const eventId = (input as { customer_event_id?: unknown }).customer_event_id;
  if (typeof eventId !== 'string' || eventId.length === 0) {
    throw new ConverlyValidationError(
      'customer_event_id is required (non-empty string). Use a stable per-account id such as ' +
        '`account_created_<your primary key>` so Converly can dedupe retries.',
    );
  }
  if (eventId.length > MAX_CUSTOMER_EVENT_ID_LEN) {
    throw new ConverlyValidationError(
      `customer_event_id must be at most ${MAX_CUSTOMER_EVENT_ID_LEN} characters (got ${eventId.length}).`,
    );
  }
  const token = (input as { correlation_token?: unknown }).correlation_token;
  if (token !== undefined && token !== null && typeof token !== 'string') {
    throw new ConverlyValidationError(
      'correlation_token must be a string or null. Pass the value from readCorrelation(req).',
    );
  }
  const allowFlag = (input as { allow_uncorrelated?: unknown }).allow_uncorrelated;
  if (allowFlag !== undefined && typeof allowFlag !== 'boolean') {
    throw new ConverlyValidationError(
      'allow_uncorrelated must be a boolean. Note that only the literal `true` enables uncorrelated ' +
        'firing — a truthy string like "true" would silently no-op, so it is rejected instead.',
    );
  }
  for (const field of ['email', 'phone', 'first_name', 'last_name'] as const) {
    const value = (input as unknown as Record<string, unknown>)[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new ConverlyValidationError(
        `${field} must be a string, null, or omitted (send raw values — Converly hashes server-side).`,
      );
    }
  }
  const email = (input as { email?: unknown }).email;
  if (typeof email === 'string' && email.trim().length > 0 && !EMAIL_SANITY_RE.test(email.trim())) {
    throw new ConverlyValidationError(
      `email does not look like an email address (got ${JSON.stringify(truncateForError(email))}). ` +
        'Pass the raw signup email, pass null, or omit the field. (Blank strings are treated as ' +
        'omitted automatically.)',
    );
  }
}

/** Trim a value for embedding in an error message. */
function truncateForError(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Return the record if `value` is a plain object, else null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Map the server's 2xx body to a typed {@link CompleteSignupResult}. */
function mapResult(parsed: unknown, customerEventId: string): CompleteSignupResult {
  const body = asRecord(parsed);
  const status = body?.status;
  const promotedCount = typeof body?.promoted_count === 'number' ? body.promoted_count : 0;
  const echoedId =
    typeof body?.customer_event_id === 'string' ? body.customer_event_id : customerEventId;

  switch (status) {
    case 'promoted':
      return { status, promoted_count: promotedCount, customer_event_id: echoedId };
    case 'promoted_uncorrelated':
      return { status, promoted_count: promotedCount, customer_event_id: echoedId };
    case 'awaiting_browser_half':
      return { status, promoted_count: 0, customer_event_id: echoedId };
    case 'no_matching_flows':
      return { status, customer_event_id: echoedId };
    case 'no_promotion':
      return { status, promoted_count: 0, customer_event_id: echoedId };
    default:
      return { status: 'unknown', customer_event_id: echoedId, raw: parsed };
  }
}
