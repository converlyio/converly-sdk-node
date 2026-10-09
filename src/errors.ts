/**
 * Error taxonomy for `@converly/sdk-node`.
 *
 * Every error is a named class with a unique, greppable, stable `code` and a
 * `docsUrl`. Messages say what to do next, not just what went wrong. Catch the
 * base {@link ConverlyError} to handle them all, or a specific subclass to
 * branch on failure mode.
 */

const DOCS_BASE = 'https://help.converly.io/setup-triggers/connect-api';

/** Build a docs URL with an optional fragment. Fragments never 404. */
function docs(anchor?: string): string {
  return anchor ? `${DOCS_BASE}#${anchor}` : DOCS_BASE;
}

/**
 * The stable, greppable code carried by every {@link ConverlyError}. These
 * strings never change across versions — safe to switch on or log-grep.
 *
 * @example
 * catch (err) {
 *   if (err instanceof ConverlyError && err.code === 'CONVERLY_UNAUTHORIZED') rotateSecret();
 * }
 */
export type ConverlyErrorCode =
  | 'CONVERLY_CONFIG_INVALID'
  | 'CONVERLY_PAYLOAD_INVALID'
  | 'CONVERLY_UNAUTHORIZED'
  | 'CONVERLY_BAD_REQUEST'
  | 'CONVERLY_SERVER_ERROR'
  | 'CONVERLY_NETWORK_ERROR';

/**
 * Base class for every error thrown by this SDK. Carries a stable {@link code}
 * and a {@link docsUrl}. Do not instantiate directly — catch it.
 *
 * @example
 * import { ConverlyError } from '@converly/sdk-node';
 * try { await converly.completeSignup({ ... }); }
 * catch (err) {
 *   if (err instanceof ConverlyError) log.warn(`[${err.code}] ${err.message} — ${err.docsUrl}`);
 * }
 */
/**
 * Brand shared across every copy of this module via the global symbol
 * registry. The dual ESM+CJS build means a mixed module graph can hold TWO
 * copies of these classes (one imported, one required); a plain prototype
 * `instanceof` across that split is always false. The brand (plus the class
 * name) restores `instanceof` across copies. Caveat: cross-copy matching of a
 * SUBCLASS compares class names, so it assumes class names survive
 * minification (true for typical Node server bundles).
 */
const CONVERLY_ERROR_BRAND = Symbol.for('converly.sdk-node.error');

export abstract class ConverlyError extends Error {
  /** Stable, greppable machine code for this failure. */
  readonly code: ConverlyErrorCode;
  /** A link to the relevant docs section for this failure. */
  readonly docsUrl: string;

  constructor(
    code: ConverlyErrorCode,
    message: string,
    options?: { docsUrl?: string; cause?: unknown },
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.docsUrl = options?.docsUrl ?? DOCS_BASE;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Keep `instanceof` working after transpilation to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
    // Non-enumerable so serialization/logging output is unchanged.
    Object.defineProperty(this, CONVERLY_ERROR_BRAND, { value: true });
  }

  /**
   * Make `instanceof` work across the ESM and CJS copies of this package
   * (dual-package hazard): fall back to a shared-symbol brand check when the
   * prototype chains don't match. Inherited by every subclass, where the
   * cross-copy fallback additionally requires the class NAME to match, so a
   * CJS `ConverlyAuthError` is `instanceof` the ESM `ConverlyAuthError` but
   * not the ESM `ConverlyRequestError`.
   */
  static override [Symbol.hasInstance](instance: unknown): boolean {
    // Normal same-copy path first.
    if (Function.prototype[Symbol.hasInstance].call(this, instance)) return true;
    // Cross-copy path: branded error + (for subclasses) matching class name.
    if (instance === null || typeof instance !== 'object') return false;
    if (!(CONVERLY_ERROR_BRAND in instance)) return false;
    if (this === ConverlyError) return true;
    return (instance as { name?: unknown }).name === (this as { name?: string }).name;
  }
}

/**
 * A {@link createClient} option was missing or invalid — thrown synchronously,
 * before any request. Fix the configuration.
 *
 * @example
 * try { createClient({ siteKey: 'x', triggerKey: 'y', webhookSecret: 'short' }); }
 * catch (err) { console.error(err.code); } // "CONVERLY_CONFIG_INVALID"
 */
export class ConverlyConfigError extends ConverlyError {
  constructor(message: string) {
    super('CONVERLY_CONFIG_INVALID', message, { docsUrl: docs('configuration') });
  }
}

/**
 * A {@link ConverlyClient.completeSignup} payload was invalid (e.g. missing
 * `customer_event_id`, or one over 200 chars). Thrown before any request. Fix
 * the payload you passed.
 *
 * @example
 * await converly.completeSignup({ correlation_token: 't' } as any)
 *   .catch((e) => e.code); // "CONVERLY_PAYLOAD_INVALID"
 */
export class ConverlyValidationError extends ConverlyError {
  constructor(message: string) {
    super('CONVERLY_PAYLOAD_INVALID', message, { docsUrl: docs('completesignup') });
  }
}

/**
 * Converly rejected the request signature (HTTP 401). The message spells out
 * the three real causes so you can fix it without guessing.
 *
 * @example
 * catch (err) {
 *   if (err instanceof ConverlyAuthError) alertOncall(err.message); // includes the 3 causes + docsUrl
 * }
 */
export class ConverlyAuthError extends ConverlyError {
  /** Always 401. */
  readonly status = 401 as const;
  /** The raw response body Converly returned (may be empty). */
  readonly responseBody: string;

  constructor(responseBody: string) {
    super(
      'CONVERLY_UNAUTHORIZED',
      'Converly rejected the webhook signature (HTTP 401). This is almost always one of three things: ' +
        '(1) the webhookSecret does not match the environment you are calling — a staging secret cannot ' +
        'sign production requests and vice versa; confirm CONVERLY_WEBHOOK_SECRET matches the apiBase. ' +
        "(2) this machine's clock is more than 5 minutes off real time — Converly rejects signatures " +
        'outside a ±5-minute window, so sync the clock via NTP. ' +
        '(3) the request body was re-serialized or altered after it was signed — the SDK signs the exact ' +
        'bytes it sends, so a proxy or middleware that re-encodes the JSON breaks the signature. ' +
        `See ${docs('401-unauthorized')}.`,
      { docsUrl: docs('401-unauthorized') },
    );
    this.responseBody = responseBody;
  }
}

/**
 * Converly rejected the request with a non-401 4xx (e.g. 400 invalid body, 404
 * unknown site). The request will **not** be retried — a 4xx is a
 * configuration/payload problem, not a transient one. Inspect
 * {@link status} and {@link responseBody}.
 *
 * @example
 * catch (err) {
 *   if (err instanceof ConverlyRequestError && err.status === 404) log.error('Unknown siteKey');
 * }
 */
export class ConverlyRequestError extends ConverlyError {
  /** The 4xx HTTP status Converly returned. */
  readonly status: number;
  /** The raw response body Converly returned (may be empty). */
  readonly responseBody: string;

  constructor(status: number, responseBody: string) {
    super(
      'CONVERLY_BAD_REQUEST',
      `Converly rejected the request with HTTP ${status} and will not retry it (4xx is a ` +
        `configuration or payload problem, not transient). Check the siteKey, triggerKey, and payload ` +
        `against the docs. Response: ${truncate(responseBody)}. See ${docs('errors')}.`,
      { docsUrl: docs('errors') },
    );
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * Converly's delivery service returned a retryable status (a 5xx, or a 429
 * rate-limit) on every attempt (initial + all retries). Transient on
 * Converly's side — safe to treat the conversion as "not yet delivered" and
 * move on; the browser/reaper safety nets may still complete it. Inspect
 * {@link status} and {@link attempts}.
 *
 * @example
 * catch (err) {
 *   if (err instanceof ConverlyServerError) log.warn(`Converly ${err.status} after ${err.attempts} tries`);
 * }
 */
export class ConverlyServerError extends ConverlyError {
  /** The last retryable HTTP status seen (a 5xx, or 429). */
  readonly status: number;
  /** Total attempts made (initial + retries). */
  readonly attempts: number;

  constructor(status: number, attempts: number) {
    super(
      'CONVERLY_SERVER_ERROR',
      `Converly's delivery service returned ${status === 429 ? 'HTTP 429 (rate limited)' : `HTTP ${status}`} ` +
        `after ${attempts} attempt(s). This is a transient problem; the signup was not delivered on this ` +
        `call. Log it and continue — do not block your user's signup. See ${docs('retries')}.`,
      { docsUrl: docs('retries') },
    );
    this.status = status;
    this.attempts = attempts;
  }
}

/**
 * The request never got a response — a network failure or a per-attempt timeout
 * on every attempt (initial + all retries). The originating error is attached
 * as {@link ConverlyError.cause | cause}.
 *
 * @example
 * catch (err) {
 *   if (err instanceof ConverlyNetworkError) log.warn('Converly unreachable', err.cause);
 * }
 */
export class ConverlyNetworkError extends ConverlyError {
  /** Total attempts made (initial + retries). */
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(
      'CONVERLY_NETWORK_ERROR',
      `Could not reach Converly's delivery service after ${attempts} attempt(s) (network error or ` +
        `per-attempt timeout). The signup was not delivered on this call. Log it and continue — do not ` +
        `block your user's signup. See ${docs('retries')}.`,
      { docsUrl: docs('retries'), cause },
    );
    this.attempts = attempts;
  }
}

/** Trim a response body for embedding in an error message. */
function truncate(text: string, max = 200): string {
  if (typeof text !== 'string') return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
