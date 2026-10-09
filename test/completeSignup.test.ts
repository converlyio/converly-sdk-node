import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createClient, ConverlyAuthError, ConverlyRequestError, ConverlyValidationError } from '../src/index';
import type { FetchLike } from '../src/index';

const SITE = 'site_test_123';
const TRIGGER = 'main-signup';
const SECRET = 'whsec_0123456789abcdef0123456789abcdef';
const API = 'https://api.test.converly.io';
const PATH = `/api/webhook-bridge/saas-signup/${SITE}/${TRIGGER}`;

function resp(status: number, body: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function makeClient(fetchImpl: (url: string, init: any) => Promise<any>) {
  return createClient({
    siteKey: SITE,
    triggerKey: TRIGGER,
    webhookSecret: SECRET,
    apiBase: API,
    fetch: fetchImpl as unknown as FetchLike,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('completeSignup — request shape & signing', () => {
  it('POSTs to the webhook URL with a signature over the exact bytes it sends', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) =>
      resp(200, { status: 'promoted', promoted_count: 1, customer_event_id: 'account_created_42' }),
    );
    const result = await makeClient(fetchImpl).completeSignup({
      correlation_token: 'a1b2c3d4e5f6a1b2',
      customer_event_id: 'account_created_42',
      email: 'user@example.com',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(API + PATH);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['User-Agent']).toMatch(/^@converly\/sdk-node\/\d+\.\d+\.\d+$/);

    const sig: string = init.headers['X-Converly-Signature'];
    const match = sig.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    expect(match).not.toBeNull();
    const ts = match![1];
    const v1 = match![2];
    // Recompute over the EXACT body string sent on the wire.
    const expected = createHmac('sha256', SECRET).update(`${ts}.POST.${PATH}.${init.body}`, 'utf8').digest('hex');
    expect(v1).toBe(expected);

    expect(result).toEqual({ status: 'promoted', promoted_count: 1, customer_event_id: 'account_created_42' });
  });

  it('sends raw (unhashed) PII and null-fills omitted optional fields', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, { status: 'promoted' }));
    await makeClient(fetchImpl).completeSignup({
      correlation_token: 'a1b2c3d4e5f60718',
      customer_event_id: 'evt',
      email: 'Aaron@Example.COM',
      phone: '+1 (415) 555-1212',
      first_name: 'Aaron',
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body).toEqual({
      correlation_token: 'a1b2c3d4e5f60718',
      customer_event_id: 'evt',
      email: 'Aaron@Example.COM',
      phone: '+1 (415) 555-1212',
      first_name: 'Aaron',
      last_name: null,
    });
  });

  it('signs the encoded path, and the signed path equals the requested path', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, { status: 'promoted' }));
    const client = createClient({
      siteKey: 'site a', // space must be percent-encoded in BOTH the URL and the signed path
      triggerKey: 'main_signup-2',
      webhookSecret: SECRET,
      apiBase: `${API}/`, // trailing slash must be trimmed
      fetch: fetchImpl as unknown as FetchLike,
    });
    await client.completeSignup({ correlation_token: 'a1b2c3d4e5f60718', customer_event_id: 'evt' });

    const encPath = `/api/webhook-bridge/saas-signup/${encodeURIComponent('site a')}/main_signup-2`;
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(API + encPath); // no double slash
    const match = (init.headers['X-Converly-Signature'] as string).match(/^t=(\d+),v1=([a-f0-9]{64})$/)!;
    const expected = createHmac('sha256', SECRET).update(`${match[1]}.POST.${encPath}.${init.body}`, 'utf8').digest('hex');
    expect(match[2]).toBe(expected);
  });

  it('rejects a triggerKey that could never match a published flow (server publish rule)', () => {
    for (const bad of ['trig/key', 'has space', 'x'.repeat(65), 'ünïcode']) {
      expect(() =>
        createClient({ siteKey: SITE, triggerKey: bad, webhookSecret: SECRET }),
      ).toThrowError(/URL-safe ASCII/);
    }
  });

  it('normalizes blank PII strings to null on the wire (the server rejects empty-string PII)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, { status: 'promoted' }));
    await makeClient(fetchImpl).completeSignup({
      correlation_token: 'a1b2c3d4e5f60718',
      customer_event_id: 'evt',
      email: '', // the classic: an empty DB column passed straight through
      phone: '   ',
      first_name: '  Aaron  ', // trimmed, not nulled
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.email).toBeNull();
    expect(body.phone).toBeNull();
    expect(body.first_name).toBe('Aaron');
    expect(body.last_name).toBeNull();
  });
});

describe('completeSignup — uncorrelated handling', () => {
  it('no-ops (no HTTP request) on a null token when allow_uncorrelated is false', async () => {
    const fetchImpl = vi.fn();
    const result = await makeClient(fetchImpl as any).completeSignup({
      correlation_token: null,
      customer_event_id: 'evt',
      allow_uncorrelated: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'skipped_uncorrelated',
      fired: false,
      reason: 'no_correlation_token',
      customer_event_id: 'evt',
    });
  });

  it('treats an empty / whitespace-only token as null (no-ops)', async () => {
    const fetchImpl = vi.fn();
    const result = await makeClient(fetchImpl as any).completeSignup({
      correlation_token: '   ',
      customer_event_id: 'evt',
      allow_uncorrelated: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped_uncorrelated');
  });

  it('fires with correlation_token=null when allow_uncorrelated is true', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, { status: 'promoted_uncorrelated', promoted_count: 1 }));
    const result = await makeClient(fetchImpl).completeSignup({
      correlation_token: null,
      customer_event_id: 'evt',
      allow_uncorrelated: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).correlation_token).toBeNull();
    expect(result).toMatchObject({ status: 'promoted_uncorrelated', promoted_count: 1 });
  });

  it('treats a corrupted (non-hex) token as unusable: skips with a distinct reason instead of a server 400', async () => {
    const fetchImpl = vi.fn();
    const result = await makeClient(fetchImpl as any).completeSignup({
      correlation_token: 'definitely-not-a-loader-token!',
      customer_event_id: 'evt',
      allow_uncorrelated: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'skipped_uncorrelated',
      fired: false,
      reason: 'invalid_correlation_token',
      customer_event_id: 'evt',
    });
  });

  it('a corrupted token with allow_uncorrelated:true degrades to an uncorrelated fire (token null on the wire)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, { status: 'promoted_uncorrelated', promoted_count: 1 }));
    const result = await makeClient(fetchImpl).completeSignup({
      correlation_token: 'corrupted###',
      customer_event_id: 'evt',
      allow_uncorrelated: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).correlation_token).toBeNull();
    expect(result).toMatchObject({ status: 'promoted_uncorrelated' });
  });

  it('rejects a non-boolean allow_uncorrelated (a string "true" would otherwise silently no-op)', async () => {
    const fetchImpl = vi.fn();
    await expect(
      makeClient(fetchImpl as any).completeSignup({
        correlation_token: null,
        customer_event_id: 'evt',
        allow_uncorrelated: 'true',
      } as any),
    ).rejects.toMatchObject({ code: 'CONVERLY_PAYLOAD_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('completeSignup — status mapping (discriminated union)', () => {
  it('maps promoted with promoted_count + customer_event_id', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, { status: 'promoted', promoted_count: 2, customer_event_id: 'evt' }));
    const r = await makeClient(fetchImpl).completeSignup({ correlation_token: 'a1b2c3d4e5f6071829', customer_event_id: 'evt' });
    expect(r).toEqual({ status: 'promoted', promoted_count: 2, customer_event_id: 'evt' });
  });

  it('maps awaiting_browser_half to promoted_count 0 even if the server omits it', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, { status: 'awaiting_browser_half', customer_event_id: 'evt' }));
    const r = await makeClient(fetchImpl).completeSignup({ correlation_token: 'a1b2c3d4e5f6071829', customer_event_id: 'evt' });
    expect(r).toEqual({ status: 'awaiting_browser_half', promoted_count: 0, customer_event_id: 'evt' });
  });

  it('maps no_matching_flows (no promoted_count field)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, { status: 'no_matching_flows', customer_event_id: 'evt' }));
    const r = await makeClient(fetchImpl).completeSignup({ correlation_token: 'a1b2c3d4e5f6071829', customer_event_id: 'evt' });
    expect(r).toEqual({ status: 'no_matching_flows', customer_event_id: 'evt' });
  });

  it('maps no_promotion to promoted_count 0', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, { status: 'no_promotion', promoted_count: 0, customer_event_id: 'evt' }));
    const r = await makeClient(fetchImpl).completeSignup({ correlation_token: 'a1b2c3d4e5f6071829', customer_event_id: 'evt' });
    expect(r).toEqual({ status: 'no_promotion', promoted_count: 0, customer_event_id: 'evt' });
  });

  it('maps an unrecognized status to `unknown` and preserves the raw body (forward-compat)', async () => {
    const raw = { status: 'brand_new_status_v9', detail: 42 };
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, raw));
    const r = await makeClient(fetchImpl).completeSignup({ correlation_token: 'a1b2c3d4e5f6071829', customer_event_id: 'evt' });
    expect(r).toEqual({ status: 'unknown', customer_event_id: 'evt', raw });
  });

  it('echoes the submitted customer_event_id when the server omits it', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, { status: 'promoted', promoted_count: 1 }));
    const r = await makeClient(fetchImpl).completeSignup({ correlation_token: 'a1b2c3d4e5f6071829', customer_event_id: 'mine' });
    expect(r).toMatchObject({ customer_event_id: 'mine' });
  });
});

describe('completeSignup — errors', () => {
  it('rejects with ConverlyRequestError on a 4xx (no retry)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(404, 'Unknown site'));
    const err = await makeClient(fetchImpl)
      .completeSignup({ correlation_token: 'a1b2c3d4e5f6071829', customer_event_id: 'evt' })
      .catch((e) => e as any);
    expect(err).toBeInstanceOf(ConverlyRequestError);
    expect(err.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects with ConverlyAuthError on a 401', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(401, 'signature_mismatch'));
    const err = await makeClient(fetchImpl)
      .completeSignup({ correlation_token: 'a1b2c3d4e5f6071829', customer_event_id: 'evt' })
      .catch((e) => e as any);
    expect(err).toBeInstanceOf(ConverlyAuthError);
    expect(err.docsUrl).toMatch(/help\.converly\.io/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects with ConverlyValidationError when customer_event_id is missing', async () => {
    const fetchImpl = vi.fn();
    await expect(
      makeClient(fetchImpl as any).completeSignup({ correlation_token: 't' } as any),
    ).rejects.toBeInstanceOf(ConverlyValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects with ConverlyValidationError when customer_event_id exceeds 200 chars', async () => {
    const fetchImpl = vi.fn();
    await expect(
      makeClient(fetchImpl as any).completeSignup({ correlation_token: 't', customer_event_id: 'x'.repeat(201) } as any),
    ).rejects.toMatchObject({ code: 'CONVERLY_PAYLOAD_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unambiguously-not-an-email value locally instead of losing the conversion to a server 400', async () => {
    const fetchImpl = vi.fn();
    await expect(
      makeClient(fetchImpl as any).completeSignup({
        correlation_token: 'a1b2c3d4e5f60718',
        customer_event_id: 'evt',
        email: 'not-an-email',
      }),
    ).rejects.toMatchObject({ code: 'CONVERLY_PAYLOAD_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still accepts normal emails (the sanity check is deliberately loose)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => resp(200, { status: 'promoted' }));
    await makeClient(fetchImpl).completeSignup({
      correlation_token: 'a1b2c3d4e5f60718',
      customer_event_id: 'evt',
      email: "weird+but.real_email'ok@sub.example.co.nz",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('completeSignup — retry wiring (fake timers)', () => {
  it('retries a 5xx through the client and resolves once it succeeds', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n < 2 ? resp(503) : resp(200, { status: 'promoted', promoted_count: 1 });
    });
    const promise = makeClient(fetchImpl).completeSignup({
      correlation_token: 'a1b2c3d4e5f60718',
      customer_event_id: 'evt',
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(n).toBe(2);
    expect(result).toMatchObject({ status: 'promoted', promoted_count: 1 });
  });

  it('signs every retry fresh: each attempt carries its own timestamp and a signature valid FOR that timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00Z'));
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n < 3 ? resp(503) : resp(200, { status: 'promoted' });
    });
    const promise = makeClient(fetchImpl).completeSignup({
      correlation_token: 'a1b2c3d4e5f60718',
      customer_event_id: 'evt',
    });
    await vi.runAllTimersAsync();
    await promise;

    const stamps: number[] = [];
    for (const [, init] of fetchImpl.mock.calls as any[]) {
      const match = (init.headers['X-Converly-Signature'] as string).match(/^t=(\d+),v1=([a-f0-9]{64})$/)!;
      stamps.push(Number(match[1]));
      // Each attempt's signature must verify against ITS OWN timestamp —
      // a reused stale signature would verify only against the first.
      const expected = createHmac('sha256', SECRET)
        .update(`${match[1]}.POST.${PATH}.${init.body}`, 'utf8')
        .digest('hex');
      expect(match[2]).toBe(expected);
    }
    // Backoffs are 1s then 3s, so attempt timestamps strictly increase.
    expect(stamps.length).toBe(3);
    expect(stamps[1]).toBeGreaterThan(stamps[0]!);
    expect(stamps[2]).toBeGreaterThan(stamps[1]!);
  });
});
