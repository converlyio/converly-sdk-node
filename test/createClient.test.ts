import { describe, it, expect, vi } from 'vitest';
import { createClient, ConverlyConfigError } from '../src/index';
import type { FetchLike } from '../src/index';

const SECRET = 'whsec_0123456789abcdef0123456789abcdef';
const okFetch = (async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' })) as unknown as FetchLike;

describe('createClient — configuration validation', () => {
  it('throws ConverlyConfigError when siteKey is missing', () => {
    expect(() => createClient({ triggerKey: 't', webhookSecret: SECRET, fetch: okFetch } as any)).toThrow(
      ConverlyConfigError,
    );
    expect(() => createClient({ triggerKey: 't', webhookSecret: SECRET, fetch: okFetch } as any)).toThrow(/siteKey/);
  });

  it('throws ConverlyConfigError when triggerKey is missing', () => {
    expect(() => createClient({ siteKey: 's', webhookSecret: SECRET, fetch: okFetch } as any)).toThrow(/triggerKey/);
  });

  it('throws ConverlyConfigError when webhookSecret is missing or too short', () => {
    expect(() => createClient({ siteKey: 's', triggerKey: 't', fetch: okFetch } as any)).toThrow(/webhookSecret/);
    expect(() =>
      createClient({ siteKey: 's', triggerKey: 't', webhookSecret: 'short', fetch: okFetch } as any),
    ).toThrow(/32 characters/);
  });

  it('carries the stable CONVERLY_CONFIG_INVALID code', () => {
    const err = (() => {
      try {
        createClient({ siteKey: '', triggerKey: 't', webhookSecret: SECRET, fetch: okFetch });
      } catch (e) {
        return e as ConverlyConfigError;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ConverlyConfigError);
    expect(err!.code).toBe('CONVERLY_CONFIG_INVALID');
  });

  it('throws when no fetch is available (no global fetch, none passed)', () => {
    const original = globalThis.fetch;
    delete (globalThis as { fetch?: unknown }).fetch;
    try {
      expect(() => createClient({ siteKey: 's', triggerKey: 't', webhookSecret: SECRET })).toThrow(/fetch/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('accepts valid options and returns a client with the documented surface', () => {
    const client = createClient({ siteKey: 's', triggerKey: 't', webhookSecret: SECRET, fetch: okFetch });
    expect(typeof client.completeSignup).toBe('function');
    expect(typeof client.readCorrelation).toBe('function');
  });

  it('uses the global fetch by default when one exists', () => {
    const spy = vi.fn();
    const original = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = spy;
    try {
      expect(() => createClient({ siteKey: 's', triggerKey: 't', webhookSecret: SECRET })).not.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });
});
