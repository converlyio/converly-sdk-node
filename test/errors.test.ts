import { describe, it, expect } from 'vitest';
import {
  ConverlyError,
  ConverlyConfigError,
  ConverlyValidationError,
  ConverlyAuthError,
  ConverlyRequestError,
  ConverlyServerError,
  ConverlyNetworkError,
} from '../src/index';

const cases: Array<[ConverlyError, string, string]> = [
  [new ConverlyConfigError('x'), 'CONVERLY_CONFIG_INVALID', 'ConverlyConfigError'],
  [new ConverlyValidationError('x'), 'CONVERLY_PAYLOAD_INVALID', 'ConverlyValidationError'],
  [new ConverlyAuthError('body'), 'CONVERLY_UNAUTHORIZED', 'ConverlyAuthError'],
  [new ConverlyRequestError(404, 'body'), 'CONVERLY_BAD_REQUEST', 'ConverlyRequestError'],
  [new ConverlyServerError(500, 4), 'CONVERLY_SERVER_ERROR', 'ConverlyServerError'],
  [new ConverlyNetworkError(4, new Error('x')), 'CONVERLY_NETWORK_ERROR', 'ConverlyNetworkError'],
];

describe('error taxonomy', () => {
  it('every error is a ConverlyError and an Error, with a stable code, name, docsUrl, and message', () => {
    const codes = new Set<string>();
    for (const [err, code, name] of cases) {
      expect(err).toBeInstanceOf(ConverlyError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.name).toBe(name);
      expect(err.docsUrl).toMatch(/^https:\/\/help\.converly\.io\/setup-triggers\/connect-api/);
      expect(err.message.length).toBeGreaterThan(0);
      codes.add(err.code);
    }
    expect(codes.size).toBe(cases.length); // all codes unique
  });

  it('is catchable via instanceof and re-throwable with its code', () => {
    try {
      throw new ConverlyServerError(503, 4);
    } catch (e) {
      expect(e instanceof ConverlyError).toBe(true);
      if (e instanceof ConverlyError) expect(e.code).toBe('CONVERLY_SERVER_ERROR');
    }
  });

  it('401 error explains the three real causes and pins status 401', () => {
    const e = new ConverlyAuthError('signature_mismatch');
    expect(e.status).toBe(401);
    expect(e.message).toMatch(/staging/); // (1) wrong secret for environment
    expect(e.message).toMatch(/clock/); // (2) clock skew
    expect(e.message).toMatch(/re-serialized/); // (3) body mutated after signing
    expect(e.responseBody).toBe('signature_mismatch');
  });

  it('4xx / 5xx errors carry status and attempt counts', () => {
    expect(new ConverlyRequestError(404, 'nope').status).toBe(404);
    expect(new ConverlyServerError(502, 4).status).toBe(502);
    expect(new ConverlyServerError(502, 4).attempts).toBe(4);
    expect(new ConverlyNetworkError(4, undefined).attempts).toBe(4);
  });

  it('network error preserves the originating cause', () => {
    const cause = new Error('ECONNRESET');
    const e = new ConverlyNetworkError(4, cause);
    expect((e as { cause?: unknown }).cause).toBe(cause);
  });
});

describe('dual-package hazard: instanceof across the ESM and CJS copies', () => {
  // The dual build means a mixed module graph can contain TWO copies of the
  // error classes. We simulate the second copy by re-importing the module
  // with a cleared module registry — same effect as the CJS bundle: same
  // source, different class identities.
  it('an error from one module copy is instanceof the OTHER copy classes (brand + name)', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const secondCopy = await import('../src/errors');
    // Different identities — the raw dual-package situation:
    expect(secondCopy.ConverlyAuthError).not.toBe(ConverlyAuthError);

    const errFromSecondCopy = new secondCopy.ConverlyAuthError('body');
    // Cross-copy base-class check (the documented catch pattern):
    expect(errFromSecondCopy instanceof ConverlyError).toBe(true);
    // Cross-copy subclass check:
    expect(errFromSecondCopy instanceof ConverlyAuthError).toBe(true);
    // ...but NOT a different subclass:
    expect(errFromSecondCopy instanceof ConverlyRequestError).toBe(false);
    // Plain objects and foreign errors stay excluded:
    expect(({} as unknown) instanceof ConverlyError).toBe(false);
    expect(new Error('x') instanceof ConverlyError).toBe(false);
  });
});
