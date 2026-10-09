/**
 * Reading the browser-set correlation cookie server-side.
 *
 * The Converly loader writes `cnv_signup_correlation` (URL-encoded, scoped to
 * the registrable domain) when a visitor interacts with the signup surface.
 * Your backend reads it here and passes it to `completeSignup`.
 */

import type { CorrelationSource } from './types';

/** The cookie the Converly loader sets. */
const COOKIE_NAME = 'cnv_signup_correlation';

/**
 * Read the `cnv_signup_correlation` cookie from a request and return its
 * (URL-decoded) value, or `null` when absent. **Never throws** — a malformed
 * cookie header yields `null`, so it is safe to call inline in a signup handler.
 *
 * Accepts, without adapters:
 * - an Express request (`req.cookies` from `cookie-parser`, or `req.get`)
 * - a raw `Cookie` header string
 * - a Web `Request`/`Headers` object (`headers.get('cookie')`) — Next.js Route
 *   Handlers, Remix loaders/actions
 * - a framework cookie accessor (`cookies.get(name)` → string or `{ value }`) —
 *   SvelteKit, Next.js `cookies()`
 *
 * @example
 * // Express
 * const token = readCorrelation(req);
 * @example
 * // Next.js Route Handler
 * const token = readCorrelation(request); // request.headers.get('cookie')
 * @example
 * // SvelteKit
 * export const actions = { default: async (event) => { const token = readCorrelation(event); } };
 * @example
 * // Raw header string
 * const token = readCorrelation('a=1; cnv_signup_correlation=abc123; b=2'); // "abc123"
 */
export function readCorrelation(
  req: CorrelationSource | string | null | undefined,
): string | null {
  try {
    if (req == null) return null;

    // (0) A raw Cookie header string passed directly.
    if (typeof req === 'string') return fromCookieHeader(req);

    const source = req as CorrelationSource;

    // (1) Cookie stores / objects.
    const cookies = source.cookies;
    if (cookies != null) {
      // (1a) Framework accessor: cookies.get(name) → string | { value } (SvelteKit, Next cookies()).
      const get = (cookies as { get?: unknown }).get;
      if (typeof get === 'function') {
        try {
          const got = (get as (n: string) => unknown).call(cookies, COOKIE_NAME);
          const val = extractCookieValue(got);
          if (val) return decode(val);
        } catch {
          /* fall through to other strategies */
        }
      }
      // (1b) Plain object populated by cookie-parser (Express).
      if (typeof cookies === 'object') {
        const direct = (cookies as Record<string, unknown>)[COOKIE_NAME];
        if (typeof direct === 'string' && direct) return decode(direct);
      }
    }

    // (2) Headers.
    const headers = source.headers;
    if (headers != null) {
      // (2a) Web Headers object: headers.get('cookie') (Next.js, Remix).
      const get = (headers as { get?: unknown }).get;
      if (typeof get === 'function') {
        try {
          const raw =
            (get as (n: string) => unknown).call(headers, 'cookie') ??
            (get as (n: string) => unknown).call(headers, 'Cookie');
          if (typeof raw === 'string') {
            const value = fromCookieHeader(raw);
            if (value != null) return value;
          }
        } catch {
          /* fall through */
        }
      }
      // (2b) Plain header map ({ cookie: '…' }).
      const rawHeader =
        (headers as Record<string, unknown>).cookie ??
        (headers as Record<string, unknown>).Cookie;
      if (typeof rawHeader === 'string') {
        const value = fromCookieHeader(rawHeader);
        if (value != null) return value;
      }
    }

    // (3) Express req.get('cookie').
    if (typeof source.get === 'function') {
      try {
        const raw = source.get('cookie');
        if (typeof raw === 'string') {
          const value = fromCookieHeader(raw);
          if (value != null) return value;
        }
      } catch {
        /* fall through */
      }
    }

    return null;
  } catch {
    // Absolute backstop — this function must never throw into a signup handler.
    return null;
  }
}

/** Pull a string value out of `cookies.get()` results (string or `{ value }`). */
function extractCookieValue(got: unknown): string | null {
  if (typeof got === 'string') return got || null;
  if (got && typeof got === 'object') {
    const value = (got as { value?: unknown }).value;
    if (typeof value === 'string') return value || null;
  }
  return null;
}

/** Find and decode `cnv_signup_correlation` in a raw `Cookie` header string. */
function fromCookieHeader(header: string): string | null {
  if (typeof header !== 'string' || header.length === 0) return null;
  const prefix = COOKIE_NAME + '=';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      // slice on the first '=' only, so '=' inside the value survives.
      return decode(trimmed.slice(prefix.length));
    }
  }
  return null;
}

/** URL-decode a cookie value, falling back to the raw value on malformed input. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
