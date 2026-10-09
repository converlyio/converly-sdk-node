import { describe, it, expect } from 'vitest';
import { readCorrelation } from '../src/index';

const NAME = 'cnv_signup_correlation';

describe('readCorrelation', () => {
  it('reads req.cookies (Express cookie-parser object)', () => {
    expect(readCorrelation({ cookies: { [NAME]: 'abc123' } })).toBe('abc123');
  });

  it('reads the raw Cookie header at req.headers.cookie', () => {
    expect(readCorrelation({ headers: { cookie: `other=foo; ${NAME}=abc123; trailing=bar` } })).toBe('abc123');
  });

  it('reads a raw Cookie header string passed directly', () => {
    expect(readCorrelation(`a=1; ${NAME}=xyz; b=2`)).toBe('xyz');
  });

  it('URL-decodes the cookie value', () => {
    expect(readCorrelation({ headers: { cookie: `${NAME}=${encodeURIComponent('a b+c')}` } })).toBe('a b+c');
  });

  it('keeps "=" inside the value (splits on the first "=" only)', () => {
    expect(readCorrelation(`${NAME}=YWJjPT0=`)).toBe('YWJjPT0=');
  });

  it('reads a Web Headers object (Next.js Route Handlers, Remix)', () => {
    const headers = new Headers({ cookie: `${NAME}=fromheaders` });
    expect(readCorrelation({ headers })).toBe('fromheaders');
  });

  it('reads a full Web Request object', () => {
    const request = new Request('https://example.com', { headers: { cookie: `${NAME}=fromrequest` } });
    expect(readCorrelation(request)).toBe('fromrequest');
  });

  it('reads a SvelteKit-style cookies.get() returning a string', () => {
    const event = { cookies: { get: (n: string) => (n === NAME ? 'svelte' : undefined) } };
    expect(readCorrelation(event)).toBe('svelte');
  });

  it('reads a Next.js cookies() store returning { value }', () => {
    const req = { cookies: { get: (n: string) => (n === NAME ? { value: 'nextval' } : undefined) } };
    expect(readCorrelation(req)).toBe('nextval');
  });

  it('supports Express req.get("cookie") as a fallback', () => {
    expect(readCorrelation({ get: (h: string) => (h === 'cookie' ? `${NAME}=viaget` : null) })).toBe('viaget');
  });

  it('returns null when the cookie is absent', () => {
    expect(readCorrelation({ cookies: {} })).toBeNull();
    expect(readCorrelation({ headers: { cookie: 'other=foo' } })).toBeNull();
    expect(readCorrelation({})).toBeNull();
    expect(readCorrelation(null)).toBeNull();
    expect(readCorrelation(undefined)).toBeNull();
    expect(readCorrelation('')).toBeNull();
  });

  it('never throws on a malformed cookie header', () => {
    const malformed = { headers: { cookie: '=;;=;===;garbage;;' } };
    expect(() => readCorrelation(malformed)).not.toThrow();
    expect(readCorrelation(malformed)).toBeNull();
  });

  it('never throws when a cookies.get accessor throws — falls through to the header', () => {
    const req = {
      cookies: {
        get: () => {
          throw new Error('boom');
        },
      },
      headers: { cookie: `${NAME}=recovered` },
    };
    expect(readCorrelation(req)).toBe('recovered');
  });

  it('prefers the cookie-parser object value when both are present', () => {
    expect(readCorrelation({ cookies: { [NAME]: 'obj' }, headers: { cookie: `${NAME}=hdr` } })).toBe('obj');
  });
});
