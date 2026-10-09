/**
 * Public type surface for `@converly/sdk-node`.
 *
 * The types are the primary documentation for this SDK: every option,
 * field, and result variant is annotated so an IDE or agent can integrate
 * against Converly without opening the website.
 */

/* -------------------------------------------------------------------------- */
/* fetch                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The minimal `fetch` shape the SDK depends on. Declared structurally so the
 * package needs neither the DOM lib nor a runtime dependency — Node 18+'s
 * global `fetch` satisfies it, and so do `undici`, `node-fetch`, and test
 * doubles.
 *
 * @example
 * import { createClient, type FetchLike } from '@converly/sdk-node';
 * import { fetch as undiciFetch } from 'undici';
 *
 * const converly = createClient({
 *   siteKey: 'site_abc',
 *   triggerKey: 'main-signup',
 *   webhookSecret: process.env.CONVERLY_WEBHOOK_SECRET!,
 *   fetch: undiciFetch as unknown as FetchLike,
 * });
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  ok?: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/* -------------------------------------------------------------------------- */
/* createClient                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Options for {@link createClient}. Only `siteKey`, `triggerKey`, and
 * `webhookSecret` are required; the rest have production-ready defaults.
 *
 * @example
 * const converly = createClient({
 *   siteKey:       process.env.CONVERLY_SITE_KEY!,
 *   triggerKey:    'main-signup',
 *   webhookSecret: process.env.CONVERLY_WEBHOOK_SECRET!,
 * });
 */
export interface CreateClientOptions {
  /**
   * Your public site identifier — the same value the browser loader uses
   * (`?key=` / `data-site-key`). Not a secret; it appears in the webhook URL.
   *
   * @example
   * siteKey: 'site_9f2c1b7a'
   */
  siteKey: string;

  /**
   * The customer-chosen identifier for this signup flow. URL-safe ASCII,
   * 1–64 chars. It becomes the last path segment of the webhook URL:
   * `/api/webhook-bridge/saas-signup/{siteKey}/{triggerKey}`.
   *
   * @example
   * triggerKey: 'main-signup'
   */
  triggerKey: string;

  /**
   * The HMAC secret used to sign every webhook request. Copy it from your
   * Converly dashboard. Minimum 32 characters. **Keep it server-side** — it
   * must never reach the browser, and the secret is environment-specific
   * (a staging secret cannot sign production requests).
   *
   * @example
   * webhookSecret: process.env.CONVERLY_WEBHOOK_SECRET! // e.g. "whsec_1a2b3c…" (≥32 chars)
   */
  webhookSecret: string;

  /**
   * Base URL of the Converly delivery service.
   *
   * @defaultValue `'https://api.converly.io'`
   * @example
   * apiBase: 'https://staging-api.converly.io'
   */
  apiBase?: string;

  /**
   * A `fetch` implementation. Defaults to the global `fetch` (Node 18+).
   * Provide one to run on older Node, or to inject a mock in tests.
   *
   * @example
   * fetch: globalThis.fetch
   */
  fetch?: FetchLike;

  /**
   * Per-attempt timeout in milliseconds. This is the ceiling for a **single**
   * HTTP attempt, not the whole retry sequence — each of the up-to-4 attempts
   * gets its own fresh timeout.
   *
   * @defaultValue `5000`
   * @example
   * timeoutMs: 3000
   */
  timeoutMs?: number;

  /**
   * Override the `User-Agent` header sent with each request. Defaults to
   * `@converly/sdk-node/<version>`.
   *
   * @example
   * userAgent: 'acme-signup-service/2.4 (+https://acme.example)'
   */
  userAgent?: string;
}

/* -------------------------------------------------------------------------- */
/* readCorrelation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A request-like object {@link readCorrelation} can read the correlation
 * cookie from. Intentionally permissive so it accepts, without adapters:
 *
 * - an Express request (`req.cookies` from `cookie-parser`, or `req.get`)
 * - a raw `Cookie` header string
 * - a Web `Request` / `Headers` object (`headers.get('cookie')`) — Next.js
 *   Route Handlers, Remix loaders/actions
 * - a framework cookie accessor (`cookies.get(name)` → string or `{ value }`)
 *   — SvelteKit, Next.js `cookies()`
 *
 * @example
 * // Express
 * readCorrelation(req);
 * // Raw header
 * readCorrelation(request.headers.get('cookie'));
 * // SvelteKit
 * readCorrelation(event);
 */
export interface CorrelationSource {
  /** `req.cookies` object, or a framework cookie store exposing `.get()`. */
  cookies?: unknown;
  /** A header map (`{ cookie: '…' }`) or a Web `Headers` object. */
  headers?: unknown;
  /** Express-style header getter, e.g. `req.get('cookie')`. */
  get?: (name: string) => unknown;
}

/* -------------------------------------------------------------------------- */
/* completeSignup — input                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fields common to every {@link CompleteSignupInput} shape.
 *
 * All personal fields are sent **raw** (not pre-hashed). Converly hashes
 * per-platform server-side, because Google and Meta require different
 * normalization and hashing. Do not hash them yourself.
 */
export interface CompleteSignupCommon {
  /**
   * Your stable identifier for this account creation. Converly dedupes on it,
   * so re-delivering the same `customer_event_id` never double-fires. Max 200
   * chars. Convention: `account_created_<immutable primary key>`.
   *
   * @example
   * customer_event_id: `account_created_${user.id}`
   */
  customer_event_id: string;

  /**
   * The new user's email, raw. Strongly recommended — it is the highest-value
   * match signal for Google Enhanced Conversions and Meta CAPI.
   *
   * @example
   * email: 'Aaron@Example.com'
   */
  email?: string | null;

  /**
   * The new user's phone, raw (any format — Converly normalizes to E.164
   * before hashing).
   *
   * @example
   * phone: '+1 (415) 555-1212'
   */
  phone?: string | null;

  /**
   * The new user's first name, raw.
   *
   * @example
   * first_name: 'Aaron'
   */
  first_name?: string | null;

  /**
   * The new user's last name, raw.
   *
   * @example
   * last_name: 'Beashel'
   */
  last_name?: string | null;
}

/**
 * The input shape when you have a real correlation token — the visitor went
 * through the Converly loader before signing up. This is the full-match-quality
 * path (click IDs + browser fingerprints + hashed PII). `allow_uncorrelated`
 * is irrelevant here and may be omitted.
 *
 * @example
 * await converly.completeSignup({
 *   correlation_token: token,               // a non-null string
 *   customer_event_id: `account_created_${user.id}`,
 *   email: user.email,
 * });
 */
export interface CompleteSignupCorrelated extends CompleteSignupCommon {
  /** A correlation token from {@link readCorrelation} (non-null). */
  correlation_token: string;
  /** Ignored when the token is present. */
  allow_uncorrelated?: boolean;
}

/**
 * The input shape when the correlation token **might be null** — e.g. you pass
 * the result of {@link readCorrelation} straight through. Here you MUST decide,
 * at the type level, what a null token means:
 *
 * - `allow_uncorrelated: false` → explicitly no-op on null (returns
 *   {@link CompleteSignupSkippedUncorrelated}, no request is sent).
 * - `allow_uncorrelated: true`  → fire anyway at degraded match quality.
 *
 * Because `allow_uncorrelated` is **required** on this shape, a nullable token
 * can never accidentally be sent without you acknowledging the null case — the
 * decision is a compile error, not a runtime surprise.
 *
 * @example
 * const token = converly.readCorrelation(req); // string | null
 * await converly.completeSignup({
 *   correlation_token: token,
 *   customer_event_id: `account_created_${user.id}`,
 *   email: user.email,
 *   allow_uncorrelated: false, // no-op if the visitor never hit the loader
 * });
 */
export interface CompleteSignupMaybeUncorrelated extends CompleteSignupCommon {
  /** A correlation token that may be null (e.g. straight from `readCorrelation`). */
  correlation_token: string | null;
  /** Required: decide whether a null token fires (`true`) or no-ops (`false`). */
  allow_uncorrelated: boolean;
}

/**
 * The payload accepted by {@link ConverlyClient.completeSignup}. A discriminated
 * union: with a definite token use {@link CompleteSignupCorrelated}; with a
 * possibly-null token use {@link CompleteSignupMaybeUncorrelated}, which forces
 * an explicit `allow_uncorrelated`.
 *
 * @example
 * // Definite token — allow_uncorrelated not needed:
 * converly.completeSignup({ correlation_token: 'a1b2…', customer_event_id: 'account_created_42' });
 * // Nullable token — allow_uncorrelated required:
 * converly.completeSignup({ correlation_token: maybeNull, customer_event_id: 'account_created_42', allow_uncorrelated: true });
 */
export type CompleteSignupInput =
  | CompleteSignupCorrelated
  | CompleteSignupMaybeUncorrelated;

/* -------------------------------------------------------------------------- */
/* completeSignup — result (discriminated union on `status`)                  */
/* -------------------------------------------------------------------------- */

/**
 * A correlated signup was accepted and queued (full match quality). One events
 * row was created per matched flow; delivery to the ad platforms happens
 * asynchronously moments later (with Converly's own retry safety nets), so
 * "promoted" means **accepted and queued for delivery**, not yet confirmed
 * delivered — check the Converly debug log for per-platform delivery status.
 *
 * @example
 * if (result.status === 'promoted') console.log(`queued ${result.promoted_count} conversion(s)`);
 */
export interface CompleteSignupPromoted {
  /** Discriminant. */
  status: 'promoted';
  /** Number of events rows created (one per matched flow). May be 0 if every flow deduped. */
  promoted_count: number;
  /** Echo of the `customer_event_id` you submitted. */
  customer_event_id: string;
}

/**
 * An **uncorrelated** signup was accepted and queued — you passed
 * `allow_uncorrelated: true` with a null token, so Converly queued it at
 * degraded match quality (no click IDs / browser fingerprints; hashed PII
 * only). Distinct from {@link CompleteSignupPromoted} so callers can tell
 * full-quality fires from degraded ones. As with `promoted`, delivery to the
 * ad platforms is asynchronous.
 *
 * @example
 * if (result.status === 'promoted_uncorrelated') metrics.increment('signup.degraded_fire');
 */
export interface CompleteSignupPromotedUncorrelated {
  /** Discriminant. */
  status: 'promoted_uncorrelated';
  /** Number of events rows created (one per matched flow). */
  promoted_count: number;
  /** Echo of the `customer_event_id` you submitted. */
  customer_event_id: string;
}

/**
 * The webhook arrived before the browser half of the pair. Converly has staged
 * your PII: if the browser signal lands within the ~5-minute merge window the
 * conversion fires with full attribution, and otherwise Converly still fires
 * it at the window's expiry with the PII you sent (degraded match quality —
 * late firing beats no firing). Nothing has fired yet at the moment this
 * status is returned.
 *
 * @example
 * if (result.status === 'awaiting_browser_half') { /* normal: browser signal in flight *\/ }
 */
export interface CompleteSignupAwaitingBrowserHalf {
  /** Discriminant. */
  status: 'awaiting_browser_half';
  /** Always 0 — nothing has fired yet. */
  promoted_count: 0;
  /** Echo of the `customer_event_id` you submitted. */
  customer_event_id: string;
}

/**
 * The `triggerKey` resolved to no active flows in your published Converly
 * config. The request was accepted and correctly signed — you just have no
 * flow wired to this signup trigger, so nothing fired. Publish/point a flow at
 * this trigger to change that.
 *
 * @example
 * if (result.status === 'no_matching_flows') log.warn('No Converly flow for this trigger yet');
 */
export interface CompleteSignupNoMatchingFlows {
  /** Discriminant. */
  status: 'no_matching_flows';
  /** Echo of the `customer_event_id` you submitted. */
  customer_event_id: string;
}

/**
 * A correlated request that produced no promotion for a reason other than a
 * pending browser half (an internal no-op — e.g. the staging row could not be
 * promoted). Rare; nothing fired.
 *
 * @example
 * if (result.status === 'no_promotion') log.info('Converly: nothing to promote');
 */
export interface CompleteSignupNoPromotion {
  /** Discriminant. */
  status: 'no_promotion';
  /** Always 0 — nothing fired. */
  promoted_count: 0;
  /** Echo of the `customer_event_id` you submitted. */
  customer_event_id: string;
}

/**
 * The client-side no-op. The token was unusable (null, or a corrupted value
 * that could never verify) and `allow_uncorrelated` was false, so
 * `completeSignup` returned **without sending any HTTP request**. This is the
 * expected outcome for admin-created accounts, backfills, or SSO users who
 * never visited the marketing site.
 *
 * @example
 * if (result.status === 'skipped_uncorrelated') { /* visitor never hit the loader — expected *\/ }
 */
export interface CompleteSignupSkippedUncorrelated {
  /** Discriminant. */
  status: 'skipped_uncorrelated';
  /** Always false — no request was sent. */
  fired: false;
  /**
   * Why the call no-opped:
   * - `'no_correlation_token'` — the token was null/blank (visitor never hit
   *   the loader). Expected and common.
   * - `'invalid_correlation_token'` — a non-empty token was supplied but it
   *   is not a loader-issued token shape (16–64 hex chars): a corrupted or
   *   tampered cookie, or the wrong value passed in. Worth logging — if you
   *   see it often, check what you're passing as `correlation_token`.
   */
  reason: 'no_correlation_token' | 'invalid_correlation_token';
  /** Echo of the `customer_event_id` you submitted. */
  customer_event_id: string;
}

/**
 * Forward-compatibility escape hatch: Converly returned a 2xx with a `status`
 * this SDK version does not recognize. The raw parsed body is attached. If you
 * see this, upgrade `@converly/sdk-node`.
 *
 * @example
 * if (result.status === 'unknown') log.warn('Unknown Converly status — upgrade the SDK', result.raw);
 */
export interface CompleteSignupUnknown {
  /** Discriminant. */
  status: 'unknown';
  /** Echo of the `customer_event_id` you submitted. */
  customer_event_id: string;
  /** The raw parsed response body. */
  raw: unknown;
}

/**
 * The result of {@link ConverlyClient.completeSignup} — a discriminated union
 * keyed on `status`. Switch on `status` for exhaustive, type-checked handling;
 * every arm carries only the fields that actually apply to it.
 *
 * @example
 * const result = await converly.completeSignup({ ... });
 * switch (result.status) {
 *   case 'promoted':
 *   case 'promoted_uncorrelated':   return result.promoted_count; // fired
 *   case 'awaiting_browser_half':   return 0;                     // will fire soon
 *   case 'no_matching_flows':
 *   case 'no_promotion':
 *   case 'skipped_uncorrelated':    return 0;                     // nothing fired
 *   case 'unknown':                 log.warn('upgrade SDK'); return 0;
 * }
 */
export type CompleteSignupResult =
  | CompleteSignupPromoted
  | CompleteSignupPromotedUncorrelated
  | CompleteSignupAwaitingBrowserHalf
  | CompleteSignupNoMatchingFlows
  | CompleteSignupNoPromotion
  | CompleteSignupSkippedUncorrelated
  | CompleteSignupUnknown;

/* -------------------------------------------------------------------------- */
/* client                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A configured Converly client, returned by {@link createClient}.
 *
 * @example
 * const converly = createClient({ siteKey, triggerKey, webhookSecret });
 * const token = converly.readCorrelation(req);
 * await converly.completeSignup({ correlation_token: token, customer_event_id: 'account_created_42', allow_uncorrelated: false });
 */
export interface ConverlyClient {
  /**
   * Read the `cnv_signup_correlation` cookie from a request. Returns the token
   * or `null`. Never throws.
   *
   * @example
   * const token = converly.readCorrelation(req);
   */
  readCorrelation(req: CorrelationSource | string | null | undefined): string | null;

  /**
   * Sign and POST the SaaS-signup webhook to Converly.
   *
   * Resolves with a {@link CompleteSignupResult}. Rejects only on a persistent
   * failure (a 4xx, or a 5xx/network error that survives the retry policy) — so
   * **always attach `.catch()`**: a Converly failure must never crash your
   * signup handler.
   *
   * @example
   * converly
   *   .completeSignup({ correlation_token: token, customer_event_id: `account_created_${user.id}`, email: user.email })
   *   .catch((err) => log.warn('converly fire failed', err));
   */
  completeSignup(input: CompleteSignupInput): Promise<CompleteSignupResult>;
}
