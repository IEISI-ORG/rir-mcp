import { KEY_RE, parseKeyRecords, sha256Hex, type ClientInfo, type KeyStore } from '@ieisi/rir-mcp-core';

/**
 * Per-user API keys in KV (spec §7): key = SHA-256 hex of the API key, value = JSON
 * `{ "clientId": "...", "quotaPerHour": 60, "revoked"?: true }`. KV caches reads at the edge for up to 60 s,
 * so a revocation takes effect within about a minute (Q10).
 */
export class KvKeyStore implements KeyStore {
  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async verify(presentedKey: string): Promise<ClientInfo | null> {
    // A string that cannot be a key never costs a KV read.
    if (!KEY_RE.test(presentedKey)) return null;
    const hash = await sha256Hex(presentedKey);
    const text = await this.kv.get(hash, { type: 'text', cacheTtl: 60 });
    if (text === null) return null;
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      // The hash goes last: the record is bound to the key that was looked up, whatever the value claims.
      const [record] = parseKeyRecords([{ ...value, sha256: hash }]);
      if (!record || record.revoked) return null;
      return { clientId: record.clientId, quotaPerHour: record.quotaPerHour };
    } catch {
      // Malformed records fail closed: no key, never unlimited.
      return null;
    }
  }
}
