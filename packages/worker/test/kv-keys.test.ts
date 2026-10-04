import { env } from 'cloudflare:workers';
import { generateKey, sha256Hex } from '@ieisi/rir-mcp-core';
import { describe, expect, it } from 'vitest';
import { KvKeyStore } from '../src/kv-keys';

/** Counts reads so tests can assert a malformed key never reaches KV. */
function counting(kv: KVNamespace): KVNamespace & { reads: number } {
  const wrapper = {
    reads: 0,
    get: (...args: Parameters<KVNamespace['get']>) => {
      wrapper.reads += 1;
      return (kv.get as (...a: unknown[]) => unknown)(...args);
    },
  };
  return wrapper as unknown as KVNamespace & { reads: number };
}

async function stored(value: string): Promise<string> {
  const key = generateKey();
  await env.API_KEYS.put(await sha256Hex(key), value);
  return key;
}

describe('KvKeyStore', () => {
  it('returns the client for a valid record', async () => {
    const key = await stored(JSON.stringify({ clientId: 'acme-noc', quotaPerHour: 30 }));
    expect(await new KvKeyStore(env.API_KEYS).verify(key)).toEqual({ clientId: 'acme-noc', quotaPerHour: 30 });
  });

  it('returns null for an unknown key and for a revoked record', async () => {
    const store = new KvKeyStore(env.API_KEYS);
    expect(await store.verify(generateKey())).toBeNull();
    const revoked = await stored(JSON.stringify({ clientId: 'gone', quotaPerHour: 30, revoked: true }));
    expect(await store.verify(revoked)).toBeNull();
  });

  it.each([
    ['malformed JSON', '{"clientId":'],
    ['a JSON array', '[{"clientId":"a","quotaPerHour":1}]'],
    ['JSON null', 'null'],
    ['a missing quota', '{"clientId":"acme"}'],
    ['a zero quota', '{"clientId":"acme","quotaPerHour":0}'],
    ['a non-integer quota', '{"clientId":"acme","quotaPerHour":"60"}'],
    ['a personal name as clientId', '{"clientId":"Jane Smith","quotaPerHour":60}'],
    ['a non-boolean revoked', '{"clientId":"acme","quotaPerHour":60,"revoked":"no"}'],
  ])('treats %s as no key, never as unlimited or a crash', async (_name, value) => {
    const key = await stored(value);
    expect(await new KvKeyStore(env.API_KEYS).verify(key)).toBeNull();
  });

  it('rejects a string that is not a key without reading KV', async () => {
    const kv = counting(env.API_KEYS);
    const store = new KvKeyStore(kv);
    for (const bad of ['', 'Bearer x', 'rirmcp_short', `rirmcp_${'A'.repeat(42)}!`, `RIRMCP_${'A'.repeat(43)}`]) {
      expect(await store.verify(bad)).toBeNull();
    }
    expect(kv.reads).toBe(0);
    await store.verify(generateKey());
    expect(kv.reads).toBe(1);
  });
});
