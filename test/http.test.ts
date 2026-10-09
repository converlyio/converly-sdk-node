import { describe, it, expect, vi } from 'vitest';
import { sendSigned, RETRY_BACKOFF_MS, type SendSignedParams } from '../src/http';
import {
  ConverlyAuthError,
  ConverlyNetworkError,
  ConverlyRequestError,
  ConverlyServerError,
} from '../src/index';

function resp(status: number, body: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async (): Promise<string> => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function params(
  fetchImpl: (url: string, init: any) => Promise<any>,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 5000,
  getHeaders: () => Record<string, string> = () => ({ 'Content-Type': 'application/json' }),
): SendSignedParams {
  return {
    url: 'https://api.test/webhook',
    getHeaders,
    rawBody: '{}',
    fetchImpl: fetchImpl as unknown as SendSignedParams['fetchImpl'],
    timeoutMs,
    sleep,
  };
}

const noSleep = async () => {};

describe('retry policy', () => {
  it('exposes the documented backoff schedule [1000, 3000, 9000] (3 retries)', () => {
    expect([...RETRY_BACKOFF_MS]).toEqual([1000, 3000, 9000]);
  });

  it('returns the parsed JSON body on 2xx with a single call', async () => {
    const fetchImpl = vi.fn(async () => resp(200, { status: 'promoted', promoted_count: 1 }));
    const out = await sendSigned(params(fetchImpl, noSleep));
    expect(out).toEqual({ status: 'promoted', promoted_count: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx on the exact backoff schedule, then succeeds', async () => {
    const delays: number[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n < 3 ? resp(503) : resp(200, { status: 'promoted' });
    });
    const out = await sendSigned(params(fetchImpl, async (ms) => void delays.push(ms)));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1000, 3000]); // two retries taken before success
    expect(out).toEqual({ status: 'promoted' });
  });

  it('exhausts 5xx after 4 attempts and throws ConverlyServerError', async () => {
    const delays: number[] = [];
    const fetchImpl = vi.fn(async () => resp(500, 'upstream boom'));
    await expect(sendSigned(params(fetchImpl, async (ms) => void delays.push(ms)))).rejects.toMatchObject({
      code: 'CONVERLY_SERVER_ERROR',
      status: 500,
      attempts: 4,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1000, 3000, 9000]); // all three retries taken
  });

  it('fails fast on 4xx with no retry and no backoff', async () => {
    const delays: number[] = [];
    const fetchImpl = vi.fn(async () => resp(400, 'bad request'));
    await expect(sendSigned(params(fetchImpl, async (ms) => void delays.push(ms)))).rejects.toBeInstanceOf(
      ConverlyRequestError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('maps 401 to ConverlyAuthError (fail fast) explaining the three causes', async () => {
    const fetchImpl = vi.fn(async () => resp(401, 'signature_mismatch'));
    const err: any = await sendSigned(params(fetchImpl, noSleep)).catch((e) => e);
    expect(err).toBeInstanceOf(ConverlyAuthError);
    expect(err.code).toBe('CONVERLY_UNAUTHORIZED');
    expect(err.message).toMatch(/staging/);
    expect(err.message).toMatch(/clock/);
    expect(err.message).toMatch(/re-serialized/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries network errors, then succeeds', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n < 2) throw new Error('ECONNRESET');
      return resp(200, { status: 'promoted' });
    });
    const out = await sendSigned(params(fetchImpl, noSleep));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ status: 'promoted' });
  });

  it('exhausts network errors and throws ConverlyNetworkError with the cause attached', async () => {
    const cause = new Error('ECONNREFUSED');
    const fetchImpl = vi.fn(async () => {
      throw cause;
    });
    const err: any = await sendSigned(params(fetchImpl, noSleep)).catch((e) => e);
    expect(err).toBeInstanceOf(ConverlyNetworkError);
    expect(err.code).toBe('CONVERLY_NETWORK_ERROR');
    expect(err.attempts).toBe(4);
    expect(err.cause).toBe(cause);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('applies the timeout per attempt: attempt 1 aborts, attempt 2 succeeds', async () => {
    let n = 0;
    const fetchImpl = (_url: string, init: any) => {
      n += 1;
      if (n === 1) {
        // Hang until the per-attempt timeout aborts us.
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted by timeout')));
        });
      }
      return Promise.resolve(resp(200, { status: 'promoted' }));
    };
    const out = await sendSigned(params(fetchImpl, noSleep, 20));
    expect(n).toBe(2);
    expect(out).toEqual({ status: 'promoted' });
  });

  it('retries 429 (rate limited) with backoff instead of failing fast', async () => {
    const delays: number[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n < 2 ? resp(429, 'Too Many Requests') : resp(200, { status: 'promoted' });
    });
    const out = await sendSigned(params(fetchImpl, async (ms) => void delays.push(ms)));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1000]);
    expect(out).toEqual({ status: 'promoted' });
  });

  it('exhausted 429s throw ConverlyServerError with a rate-limited message', async () => {
    const fetchImpl = vi.fn(async () => resp(429, 'Too Many Requests'));
    const err: any = await sendSigned(params(fetchImpl, noSleep)).catch((e) => e);
    expect(err).toBeInstanceOf(ConverlyServerError);
    expect(err.status).toBe(429);
    expect(err.attempts).toBe(4);
    expect(err.message).toMatch(/rate limited/);
  });

  it('the per-attempt timeout covers the response BODY: a 2xx whose json() stalls forever aborts and retries', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        // Headers arrive fine, but the body never does — and this json()
        // deliberately IGNORES the abort signal, like a badly-behaved
        // custom fetch. sendSigned must still time out via its own race.
        return { status: 200, json: () => new Promise(() => {}), text: async (): Promise<string> => '' };
      }
      return resp(200, { status: 'promoted' });
    });
    const out = await sendSigned(params(fetchImpl, noSleep, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ status: 'promoted' });
  });

  it('an unparseable 2xx body is a retryable transport fault, NOT a silent `unknown` success', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return {
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected end of JSON input');
          },
          text: async (): Promise<string> => '',
        };
      }
      return resp(200, { status: 'promoted', promoted_count: 1 });
    });
    const out = await sendSigned(params(fetchImpl, noSleep));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ status: 'promoted', promoted_count: 1 });
  });

  it('an unparseable 2xx body on EVERY attempt exhausts to ConverlyNetworkError', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError('bad json');
      },
      text: async () => '',
    }));
    const err: any = await sendSigned(params(fetchImpl, noSleep)).catch((e) => e);
    expect(err).toBeInstanceOf(ConverlyNetworkError);
    expect(err.attempts).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('a 4xx whose text() stalls forever still rejects promptly (empty body in the error)', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 400,
      json: async () => ({}),
      text: () => new Promise<string>(() => {}), // never resolves, ignores abort
    }));
    const err: any = await sendSigned(params(fetchImpl, noSleep, 20)).catch((e) => e);
    expect(err).toBeInstanceOf(ConverlyRequestError);
    expect(err.status).toBe(400);
    expect(err.responseBody).toBe('');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a fetch that IGNORES the abort signal and never resolves still times out and retries', async () => {
    let n = 0;
    const fetchImpl = vi.fn((_url: string, _init: any) => {
      n += 1;
      if (n === 1) {
        // Never resolves, never looks at init.signal — a broken custom
        // fetch adapter. The per-attempt deadline must still bind.
        return new Promise(() => {});
      }
      return Promise.resolve(resp(200, { status: 'promoted' }));
    });
    const out = await sendSigned(params(fetchImpl as any, noSleep, 20));
    expect(n).toBe(2);
    expect(out).toEqual({ status: 'promoted' });
  });

  it('a response arriving AFTER the attempt expired is a timeout, never a terminal late 4xx', async () => {
    let n = 0;
    const fetchImpl = vi.fn((_url: string, _init: any) => {
      n += 1;
      if (n === 1) {
        // Resolves with a 400 at 60ms — well past the 20ms deadline, and
        // ignoring the signal. The expired attempt must be classified as
        // a retryable timeout; treating the late 400 as terminal would
        // drop the conversion on what was really a slow network.
        return new Promise((resolve) => setTimeout(() => resolve(resp(400, 'too late')), 60));
      }
      return Promise.resolve(resp(200, { status: 'promoted' }));
    });
    const out = await sendSigned(params(fetchImpl as any, noSleep, 20));
    expect(n).toBe(2);
    expect(out).toEqual({ status: 'promoted' }); // retried, NOT ConverlyRequestError(400)
  });

  it('an ON-TIME 4xx is still terminal (the late-response guard must not weaken fail-fast)', async () => {
    const fetchImpl = vi.fn(async () => resp(422, 'nope'));
    const err: any = await sendSigned(params(fetchImpl, noSleep, 5000)).catch((e) => e);
    expect(err).toBeInstanceOf(ConverlyRequestError);
    expect(err.status).toBe(422);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a throwing getHeaders (signing failure) surfaces immediately — no retries, no ConverlyNetworkError disguise', async () => {
    const fetchImpl = vi.fn();
    const boom = new Error('crypto unavailable');
    const err: any = await sendSigned(
      params(fetchImpl as any, noSleep, 5000, () => {
        throw boom;
      }),
    ).catch((e) => e);
    expect(err).toBe(boom); // the raw signing error, not a network-error wrapper
    expect(fetchImpl).not.toHaveBeenCalled(); // and fetch never ran
  });

  it('calls getHeaders once per attempt so every retry is signed fresh', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n < 3 ? resp(503) : resp(200, { status: 'promoted' });
    });
    const getHeaders = vi.fn(() => ({ 'X-Attempt-Stamp': String(n) }));
    await sendSigned(params(fetchImpl, noSleep, 5000, getHeaders));
    expect(getHeaders).toHaveBeenCalledTimes(3); // once per attempt, not once total
    // And the headers passed to fetch were the fresh ones each time.
    expect(fetchImpl.mock.calls.map((c: any[]) => c[1].headers['X-Attempt-Stamp'])).toEqual([
      '0',
      '1',
      '2',
    ]);
  });
});
