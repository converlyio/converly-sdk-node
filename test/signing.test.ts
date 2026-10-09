import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildSigningString, signRequest, parseSignatureHeader } from '../src/signing';

const SECRET = 'whsec_0123456789abcdef0123456789abcdef';
const TS = 1735689600;
const PATH = '/api/webhook-bridge/saas-signup/site_test_123/main-signup';

describe('buildSigningString', () => {
  it('joins ts.METHOD.path.body and uppercases the method', () => {
    expect(buildSigningString(TS, 'post', '/p', '{"a":1}')).toBe(`${TS}.POST./p.{"a":1}`);
  });

  it('does not normalize the path or strip anything from the body', () => {
    expect(buildSigningString(1, 'POST', '/a/b/', 'raw.body.with.dots')).toBe('1.POST./a/b/.raw.body.with.dots');
  });
});

describe('signRequest — known-good fixed vectors', () => {
  it('reproduces the exact HMAC vector for an ASCII body', () => {
    const rawBody = JSON.stringify({
      correlation_token: 'a1b2c3d4e5f6a1b2',
      customer_event_id: 'account_created_42',
      email: 'user@example.com',
      phone: null,
      first_name: null,
      last_name: null,
    });
    const { signature, header, signingString } = signRequest({
      timestamp: TS,
      method: 'POST',
      path: PATH,
      rawBody,
      secret: SECRET,
    });
    expect(signature).toBe('ce1f632629a03aee3c13171ae3fc8ef6b1bf90063ce399ee28b55c51409e857a');
    expect(header).toBe(`t=${TS},v1=${signature}`);
    expect(signingString.endsWith(`.${rawBody}`)).toBe(true);
  });

  it('round-trips non-ASCII PII via utf8 (matches the server decoding it as utf8)', () => {
    const rawBody = JSON.stringify({
      correlation_token: 'tok',
      customer_event_id: 'evt',
      email: 'aarón@example.com',
      phone: null,
      first_name: 'Zoë',
      last_name: null,
    });
    const { signature } = signRequest({ timestamp: TS, method: 'POST', path: PATH, rawBody, secret: SECRET });
    expect(signature).toBe('0312a3d86116da5eeaaae9ecf694bca9c1a688d2b7cf5c6e1f7125c5ae4361ae');
  });

  it('emits t=<int>,v1=<64 lowercase hex>', () => {
    const { header } = signRequest({ timestamp: TS, method: 'POST', path: PATH, rawBody: '{}', secret: SECRET });
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });

  it('signs the exact bytes it is given (a different body → a different signature)', () => {
    const a = signRequest({ timestamp: TS, method: 'POST', path: PATH, rawBody: '{"a":1}', secret: SECRET }).signature;
    const b = signRequest({ timestamp: TS, method: 'POST', path: PATH, rawBody: '{"a":2}', secret: SECRET }).signature;
    expect(a).not.toBe(b);
  });
});

describe('parseSignatureHeader — tolerant, rotation-safe', () => {
  it('parses a single t + v1', () => {
    const sig = 'a'.repeat(64);
    expect(parseSignatureHeader(`t=1700000000,v1=${sig}`)).toEqual({ timestamp: 1700000000, signatures: [sig] });
  });

  it('collects multiple v1 values (key rotation) and tolerates whitespace', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(parseSignatureHeader(` t=1700000000 , v1=${a} , v1=${b} `)).toEqual({
      timestamp: 1700000000,
      signatures: [a, b],
    });
  });

  it('ignores unknown versions and malformed signatures', () => {
    const a = 'a'.repeat(64);
    expect(parseSignatureHeader(`t=1,v2=deadbeef,v1=${a},v1=nothex`).signatures).toEqual([a]);
  });

  it('round-trips a header emitted by signRequest', () => {
    const { header, signature } = signRequest({ timestamp: 123, method: 'POST', path: '/p', rawBody: '{}', secret: SECRET });
    const parsed = parseSignatureHeader(header);
    expect(parsed.timestamp).toBe(123);
    expect(parsed.signatures).toEqual([signature]);
  });

  it('matches the server: recomputing from the parsed header reproduces the signature', () => {
    const rawBody = '{"customer_event_id":"evt"}';
    const { header } = signRequest({ timestamp: TS, method: 'POST', path: PATH, rawBody, secret: SECRET });
    const { timestamp, signatures } = parseSignatureHeader(header);
    const recomputed = createHmac('sha256', SECRET).update(`${timestamp}.POST.${PATH}.${rawBody}`, 'utf8').digest('hex');
    expect(signatures).toContain(recomputed);
  });
});
