import type { ClientInfo, KeyStore } from '../ports';

export const KEY_PREFIX = 'rirmcp_';
export const KEY_RE = /^rirmcp_[A-Za-z0-9_-]{43}$/;
/** Opaque, log-safe client identifiers: never a person's name or email. */
export const CLIENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_QUOTA_PER_HOUR = 60;
/** Upper bound for any key's quota: a typo such as 1e23 must not issue an effectively unlimited key. */
export const MAX_QUOTA_PER_HOUR = 1_000_000;

export function validQuota(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_QUOTA_PER_HOUR;
}
const HASH_RE = /^[0-9a-f]{64}$/;

export interface KeyRecord {
  readonly sha256: string;
  readonly clientId: string;
  readonly quotaPerHour: number;
  readonly touVersion?: string;
  readonly revoked?: boolean;
}

export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return KEY_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Runs over the longer input whatever the content, so timing reveals neither position nor length match. */
export function constantTimeEqual(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function parseKeyRecords(json: unknown): KeyRecord[] {
  if (!Array.isArray(json)) throw new Error('keys file must be a JSON array of key records');
  const hashes = new Set<string>();
  const ids = new Set<string>();
  return json.map((r: unknown, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const bad = (what: string) => new Error(`key record ${i}: ${what}`);
    if (typeof o.sha256 !== 'string' || !HASH_RE.test(o.sha256)) throw bad('sha256 must be 64 lowercase hex digits');
    if (typeof o.clientId !== 'string' || !CLIENT_ID_RE.test(o.clientId)) throw bad('clientId must match ^[a-z0-9][a-z0-9-]{0,31}$');
    if (!validQuota(o.quotaPerHour)) throw bad(`quotaPerHour must be an integer from 1 to ${MAX_QUOTA_PER_HOUR}`);
    if (o.touVersion !== undefined && typeof o.touVersion !== 'string') throw bad('touVersion must be a string');
    if (o.revoked !== undefined && typeof o.revoked !== 'boolean') throw bad('revoked must be a boolean');
    if (hashes.has(o.sha256)) throw bad('duplicate sha256');
    if (ids.has(o.clientId)) throw bad('duplicate clientId');
    hashes.add(o.sha256);
    ids.add(o.clientId);
    return {
      sha256: o.sha256, clientId: o.clientId, quotaPerHour: o.quotaPerHour as number,
      ...(o.touVersion !== undefined ? { touVersion: o.touVersion as string } : {}),
      ...(o.revoked !== undefined ? { revoked: o.revoked as boolean } : {}),
    };
  });
}

export class SingleKeyStore implements KeyStore {
  private readonly hash: Promise<string>;
  private readonly quotaPerHour: number;

  constructor(key: string, quotaPerHour = DEFAULT_QUOTA_PER_HOUR) {
    if (!KEY_RE.test(key)) throw new Error('API key must be rirmcp_ followed by 43 base64url characters (generate one with scripts/keys.ts)');
    // NaN would make every quota comparison false, i.e. unlimited: fail closed instead.
    if (!validQuota(quotaPerHour)) throw new Error(`quotaPerHour must be an integer from 1 to ${MAX_QUOTA_PER_HOUR}`);
    this.hash = sha256Hex(key);
    this.quotaPerHour = quotaPerHour;
  }

  async verify(presentedKey: string): Promise<ClientInfo | null> {
    // Compare hashes: equal length always, and the configured key never meets the comparison loop.
    const ok = constantTimeEqual(await sha256Hex(presentedKey), await this.hash);
    return ok ? { clientId: 'default', quotaPerHour: this.quotaPerHour } : null;
  }
}

export class RecordKeyStore implements KeyStore {
  private readonly byHash: ReadonlyMap<string, KeyRecord>;

  constructor(records: readonly KeyRecord[]) {
    this.byHash = new Map(records.map((r) => [r.sha256, r]));
  }

  async verify(presentedKey: string): Promise<ClientInfo | null> {
    if (!KEY_RE.test(presentedKey)) return null;
    const hash = await sha256Hex(presentedKey);
    // Lookup is by SHA-256 of the secret: an attacker cannot steer the hash, so map timing reveals nothing useful.
    const r = this.byHash.get(hash);
    if (!r || r.revoked || !constantTimeEqual(r.sha256, hash)) return null;
    return { clientId: r.clientId, quotaPerHour: r.quotaPerHour };
  }
}
