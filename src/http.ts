/**
 * The signed-request transport: one signed POST, with a per-attempt timeout
 * and the retry policy.
 *
 * Retry policy (matches the documented Connect API contract):
 * - 5xx responses, 429 rate-limits, and network/timeout errors retry
 *   **3 times** with 1s, 3s, 9s backoff (4 attempts total).
 * - Other 4xx responses fail fast — no retry.
 * - The timeout is **per attempt**, not a total budget: each attempt gets its
 *   own fresh {@link AbortController}, and the timeout covers the WHOLE
 *   attempt — including reading the response body. A server that returns
 *   headers and then stalls the body still times out and retries.
 * - Each attempt is signed fresh (the caller passes a header factory), so a
 *   slow retry sequence can never drift outside the server's ±5-minute
 *   signature-freshness window.
 */

import {
  ConverlyAuthError,
  ConverlyNetworkError,
  ConverlyRequestError,
  ConverlyServerError,
  type ConverlyError,
} from './errors';
import type { FetchLike } from './types';

/**
 * Backoff delays before retry attempts 2, 3, and 4. Three entries → three
 * retries after the initial attempt.
 * @internal
 */
export const RETRY_BACKOFF_MS = [1000, 3000, 9000] as const;

/** Default sleep, overridable in tests. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parameters for {@link sendSigned}. @internal */
export interface SendSignedParams {
  url: string;
  /**
   * Called at the START of every attempt so each retry carries a
   * freshly-signed header (new `t=` timestamp). Never reuse a signature
   * across attempts — a long timeout plus backoff can push a reused
   * signature outside the server's freshness window.
   */
  getHeaders: () => Record<string, string>;
  rawBody: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  /** Overridable sleep (tests inject a controllable clock). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * POST a pre-signed request and return the parsed 2xx JSON body. Throws a typed
 * {@link ConverlyError} on any terminal failure.
 *
 * @internal
 */
export async function sendSigned(params: SendSignedParams): Promise<unknown> {
  const sleep = params.sleep ?? defaultSleep;
  const maxAttempts = RETRY_BACKOFF_MS.length + 1; // initial + 3 retries = 4
  let lastRetryable: ConverlyError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delayMs = RETRY_BACKOFF_MS[attempt - 2] ?? 0;
      await sleep(delayMs);
    }

    // One controller per attempt. It stays armed until the response BODY
    // has been consumed — clearing it after headers would let a stalled
    // body hang the caller forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);

    try {
      // Evaluate the header factory OUTSIDE the network catch below — a
      // signing failure is a local programming/configuration error, not a
      // transient network fault. It must surface immediately, not after 13
      // seconds of doomed retries disguised as ConverlyNetworkError.
      const headers = params.getHeaders();

      let res: Awaited<ReturnType<FetchLike>>;
      try {
        // The fetch promise itself races the abort deadline too: a custom
        // fetch implementation that ignores `signal` (an adapter, proxy
        // wrapper, or instrumentation layer) must still honor the
        // documented per-attempt timeout — and a response that arrives
        // AFTER the attempt expired is treated as the timeout it is,
        // never as a terminal late 4xx.
        res = await raceAbort(
          params.fetchImpl(params.url, {
            method: 'POST',
            headers,
            body: params.rawBody,
            signal: controller.signal,
          }),
          controller.signal,
          params.timeoutMs,
        );
      } catch (err) {
        // Network failure / per-attempt timeout / abort → retryable.
        lastRetryable = new ConverlyNetworkError(attempt, err);
        continue;
      }

      const status = res.status;

      if (status >= 200 && status < 300) {
        // Body read races the same abort deadline, so a fetch
        // implementation whose json() ignores the signal still can't
        // hang us. An unreadable/unparseable 2xx body is a transport
        // fault (the server always returns JSON) → retryable, NOT a
        // silent `{status:'unknown'}` success.
        try {
          return await raceAbort(res.json(), controller.signal, params.timeoutMs);
        } catch (err) {
          lastRetryable = new ConverlyNetworkError(attempt, err);
          continue;
        }
      }
      if (status === 401) {
        throw new ConverlyAuthError(await safeText(res, controller.signal, params.timeoutMs));
      }
      if (status === 429) {
        // Rate-limited. Retrying with backoff is safe (customer_event_id
        // dedup) and usually lands inside the next limiter window.
        lastRetryable = new ConverlyServerError(status, attempt);
        continue;
      }
      if (status >= 400 && status < 500) {
        throw new ConverlyRequestError(
          status,
          await safeText(res, controller.signal, params.timeoutMs),
        );
      }
      // 5xx (or any other >= 500) → retryable.
      lastRetryable = new ConverlyServerError(status, attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  // Exhausted all attempts on a retryable failure.
  throw lastRetryable ?? new ConverlyNetworkError(maxAttempts, undefined);
}

/**
 * Race a promise (the fetch itself, or a body read) against the attempt's
 * abort signal, so the per-attempt timeout binds even when the underlying
 * fetch implementation ignores the AbortSignal entirely. Once the deadline
 * fires, a late settlement of the underlying promise is discarded — it can
 * never resurface as a late success or a terminal late 4xx.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error(`Attempt aborted (per-attempt timeout ${timeoutMs}ms)`));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new Error(`Attempt timed out (per-attempt timeout ${timeoutMs}ms)`));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Read a response as text under the abort deadline, tolerating failure (→ ''). */
async function safeText(
  res: { text(): Promise<string> },
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  try {
    return await raceAbort(res.text(), signal, timeoutMs);
  } catch {
    return '';
  }
}
