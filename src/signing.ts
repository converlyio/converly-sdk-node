/**
 * HMAC request signing for the Converly SaaS-signup webhook.
 *
 * The signature is computed over the EXACT bytes sent on the wire. The caller
 * serializes the body to a string once, signs that string, and sends that same
 * string — see {@link ../client!createClient}. Never sign an object; never let
 * a second `JSON.stringify` or a re-encoding middleware run after signing.
 */

import { createHmac } from 'node:crypto';

/**
 * Build the canonical signing string:
 * `{unix_ts}.{METHOD_UPPERCASE}.{path}.{raw_body}`.
 *
 * `path` must be the full request path with a leading slash, no query string,
 * and no trailing-slash normalization — exactly what appears on the HTTP
 * request line. `rawBody` must be the exact string used as the request body.
 *
 * @internal
 * @example
 * buildSigningString(1735689600, 'POST', '/api/webhook-bridge/saas-signup/site_x/main', '{"a":1}');
 * // "1735689600.POST./api/webhook-bridge/saas-signup/site_x/main.{\"a\":1}"
 */
export function buildSigningString(
  timestamp: number,
  method: string,
  path: string,
  rawBody: string,
): string {
  return `${timestamp}.${method.toUpperCase()}.${path}.${rawBody}`;
}

/**
 * Sign a request. Returns the canonical signing string, the lowercase hex
 * HMAC-SHA256 signature, and the ready-to-send `X-Converly-Signature` header
 * value (`t=<ts>,v1=<hex>`).
 *
 * @internal
 * @example
 * const { header } = signRequest({
 *   timestamp: Math.floor(Date.now() / 1000),
 *   method: 'POST',
 *   path: '/api/webhook-bridge/saas-signup/site_x/main-signup',
 *   rawBody: body,          // the SAME string passed as fetch's body
 *   secret: webhookSecret,
 * });
 * // header === "t=1735689600,v1=9f86d081…"
 */
export function signRequest(params: {
  timestamp: number;
  method: string;
  path: string;
  rawBody: string;
  secret: string;
}): { signingString: string; signature: string; header: string } {
  const signingString = buildSigningString(
    params.timestamp,
    params.method,
    params.path,
    params.rawBody,
  );
  // utf8 encoding matches how the server re-reads the body
  // (`rawBody.toString('utf8')`), so non-ASCII PII round-trips correctly.
  const signature = createHmac('sha256', params.secret)
    .update(signingString, 'utf8')
    .digest('hex');
  return { signingString, signature, header: `t=${params.timestamp},v1=${signature}` };
}

/**
 * The parsed pieces of an `X-Converly-Signature` header.
 * @internal
 */
export interface ParsedSignatureHeader {
  /** The unix timestamp (`t=`), or `NaN` if absent/unparseable. */
  timestamp: number;
  /** All well-formed 64-hex `v1=` signatures, lowercased. */
  signatures: string[];
}

/**
 * Tolerantly parse an `X-Converly-Signature` header
 * (`t=<int>,v1=<hex>[,v1=<hex>…]`). Whitespace-tolerant, and it collects
 * **multiple** `v1=` values so future key rotation (signing with both the old
 * and new secret during a cutover) does not break parsing. Unknown keys are
 * ignored.
 *
 * The client only ever *emits* one `v1=`; this mirrors the server's parser and
 * is used by the test suite to prove the emitted header round-trips and that
 * rotation-style headers with extra `v1=` values parse cleanly.
 *
 * @internal
 * @example
 * parseSignatureHeader('t=1735689600, v1=aa…aa, v1=bb…bb');
 * // { timestamp: 1735689600, signatures: ['aa…aa', 'bb…bb'] }
 */
export function parseSignatureHeader(header: string): ParsedSignatureHeader {
  const result: ParsedSignatureHeader = { timestamp: Number.NaN, signatures: [] };
  for (const part of String(header).split(',')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const val = trimmed.slice(eq + 1).trim();
    if (key === 't') {
      const n = Number.parseInt(val, 10);
      if (Number.isFinite(n)) result.timestamp = n;
    } else if (key === 'v1') {
      if (/^[a-f0-9]{64}$/i.test(val)) result.signatures.push(val.toLowerCase());
    }
    // Unknown versions (v2, v3, …) are silently skipped — forward-compatible.
  }
  return result;
}
