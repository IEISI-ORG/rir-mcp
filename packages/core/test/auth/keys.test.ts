import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual, generateKey, KEY_RE, parseKeyRecords, RecordKeyStore, sha256Hex, SingleKeyStore,
} from '../../src/auth/keys';

const KEY = 'rirmcp_' + 'A'.repeat(43);

describe('keys', () => {
  it('generates keys in the documented format, all distinct', () => {
    const keys = new Set(Array.from({ length: 50 }, generateKey));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(KEY_RE);
  });

  it('hashes with SHA-256 hex', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('compares in constant time over the longer input', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('SingleKeyStore', () => {
  it('accepts only the exact key, as client "default"', async () => {
    const s = new SingleKeyStore(KEY);
    expect(await s.verify(KEY)).toEqual({ clientId: 'default', quotaPerHour: 60 });
    expect(await s.verify(KEY.slice(0, -1) + 'B')).toBeNull();
    expect(await s.verify(KEY + 'A')).toBeNull();
    expect(await s.verify('')).toBeNull();
  });

  it('rejects a configured key that is not in the documented format', () => {
    expect(() => new SingleKeyStore('short')).toThrow(/rirmcp_/);
  });
});

describe('RecordKeyStore', () => {
  it('finds a client by key hash and refuses revoked keys', async () => {
    const other = 'rirmcp_' + 'B'.repeat(43);
    const store = new RecordKeyStore([
      { sha256: await sha256Hex(KEY), clientId: 'alpha', quotaPerHour: 30 },
      { sha256: await sha256Hex(other), clientId: 'beta', quotaPerHour: 60, revoked: true },
    ]);
    expect(await store.verify(KEY)).toEqual({ clientId: 'alpha', quotaPerHour: 30 });
    expect(await store.verify(other)).toBeNull();
    expect(await store.verify('rirmcp_' + 'C'.repeat(43))).toBeNull();
    expect(await store.verify('not-a-key')).toBeNull();
  });
});

describe('parseKeyRecords', () => {
  const ok = { sha256: 'a'.repeat(64), clientId: 'alpha', quotaPerHour: 60 };
  it('accepts a valid array', () => {
    expect(parseKeyRecords([ok, { ...ok, sha256: 'b'.repeat(64), clientId: 'beta', revoked: true, touVersion: '2026-10' }])).toHaveLength(2);
  });
  it.each([
    ['not an array', { keys: [] }],
    ['bad hash', [{ ...ok, sha256: 'xyz' }]],
    ['uppercase hash', [{ ...ok, sha256: 'A'.repeat(64) }]],
    ['bad clientId', [{ ...ok, clientId: 'Alice Smith' }]],
    ['zero quota', [{ ...ok, quotaPerHour: 0 }]],
    ['fractional quota', [{ ...ok, quotaPerHour: 1.5 }]],
    ['duplicate hash', [ok, { ...ok, clientId: 'beta' }]],
    ['duplicate clientId', [ok, { ...ok, sha256: 'b'.repeat(64) }]],
  ])('rejects %s', (_name, input) => {
    expect(() => parseKeyRecords(input)).toThrow();
  });
});
