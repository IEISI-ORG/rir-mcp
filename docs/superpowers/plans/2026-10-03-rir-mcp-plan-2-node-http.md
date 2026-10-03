# rir-mcp Plan 2 — Node Streamable HTTP + auth + per-client controls

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the five rir-mcp tools over authenticated Streamable HTTP from Node, with per-client quotas, a scan detector, and value-free logging.

**Architecture:** Runtime-neutral pieces go in `core` so Plan 3 (Worker) reuses them: key hashing and the `KeyStore` port with two in-memory stores, a `ClientGate` port with a memory implementation (quota + scan detector), and a `RirService.forClient()` view that charges the gate on upstream calls and observes scan units on every query. `node` adds config loading (fail closed), a `node:http` ↔ web `Request`/`Response` bridge, the request gate (path → Host → Origin → Bearer), and an SDK `createMcpHandler` whose per-request factory builds a server bound to the authenticated client.

**Tech Stack:** TypeScript, Node 24, `@modelcontextprotocol/server` 2.2 (`createMcpHandler`, `requireBearerAuth`, `validateHostHeader`, `validateOriginHeader`), `@modelcontextprotocol/client` 2.2 (`StreamableHTTPClientTransport`, tests only), vitest, Web Crypto.

**Spec:** `docs/superpowers/specs/2026-09-30-rir-mcp-core-design.md` (§6 ports, §7 auth / anti-harvesting / logging, §10 deployment).

## Global Constraints

- No PII held, returned, logged or committed. Logs never contain query values, API keys, `Authorization` headers or registry payloads (spec §7 Logging).
- Logged per tool call: tool, RIR, cache outcome, latency, clientId, outcome code (spec §7 Logging).
- One scheme: `Authorization: Bearer <key>`. Per-user mode takes precedence over single key. Neither configured → refuse to start HTTP (spec §7).
- Keys: `rirmcp_` + 32 random bytes base64url (43 chars); only SHA-256 hashes stored in per-user mode; comparison is constant-time (spec §7).
- Node HTTP binds `127.0.0.1` by default; Origin validated, 403 when present and invalid; public binding is an explicit option (spec §7).
- Per-client quota: 60 upstream calls/hour, cache hits free (spec §7).
- Scan detector: per client, distinct /24s (v4), /48s (v6), ASNs per hour; above 200 → suspend, alert operator; counts only, never values (spec §7).
- `core` imports no `node:` modules, no `Buffer`, no `process.` (enforced by `packages/core/test/purity.test.ts`); files < 400 lines.
- `RIR_MCP_OPERATOR` is still required in every mode (spec §10).
- stdout of the stdio entry carries only protocol frames; diagnostics go to stderr.
- Run pnpm as `corepack pnpm`. Node entry points call `setDefaultAutoSelectFamilyAttemptTimeout(2000)`.
- No new runtime dependencies.

## Review Focus

1. A request with a valid key but a browser `Origin` from another site (DNS-rebinding / CSRF) → 403 before auth or any tool runs. Test in Task 6.
2. A key that differs from the configured one only in its last character, or has a different length → 401, never a crash; no timing shortcut on length. Test in Task 1.
3. A client that exhausts its quota but asks for something already cached → still answered from cache (quota counts upstream calls only). Test in Task 3.
4. Binding to `0.0.0.0` without `RIR_MCP_ALLOWED_HOSTS` → refuse to start (otherwise DNS rebinding reaches a public bind). Test in Task 5.
5. An oversized or slow request body → rejected (413 / timeout) without building a server instance. Test in Task 6.

---

### Task 1: Key format, hashing and key stores (core)

**Files:**
- Create: `packages/core/src/auth/keys.ts`
- Modify: `packages/core/src/ports.ts` (add `KeyStore`, `ClientInfo`)
- Modify: `packages/core/src/index.ts` (exports)
- Test: `packages/core/test/auth/keys.test.ts`

**Interfaces:**
- Produces:
  - `interface ClientInfo { readonly clientId: string; readonly quotaPerHour: number }`
  - `interface KeyStore { verify(presentedKey: string): Promise<ClientInfo | null> }`
  - `interface KeyRecord { readonly sha256: string; readonly clientId: string; readonly quotaPerHour: number; readonly touVersion?: string; readonly revoked?: boolean }`
  - `const KEY_PREFIX = 'rirmcp_'`, `const KEY_RE = /^rirmcp_[A-Za-z0-9_-]{43}$/`, `const CLIENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/`, `const DEFAULT_QUOTA_PER_HOUR = 60`
  - `generateKey(): string` (Web Crypto `getRandomValues`)
  - `sha256Hex(s: string): Promise<string>` (Web Crypto `subtle.digest`)
  - `constantTimeEqual(a: string, b: string): boolean`
  - `parseKeyRecords(json: unknown): KeyRecord[]` — throws `Error` naming the first bad index
  - `class SingleKeyStore implements KeyStore { constructor(key: string, quotaPerHour?: number) }` → clientId `default`
  - `class RecordKeyStore implements KeyStore { constructor(records: readonly KeyRecord[]) }`

- [ ] **Step 1: Write the failing tests**

```ts
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
    expect(parseKeyRecords([ok, { ...ok, clientId: 'beta', revoked: true, touVersion: '2026-10' }])).toHaveLength(2);
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
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm vitest run packages/core/test/auth/keys.test.ts`
Expected: FAIL, cannot resolve `../../src/auth/keys`.

- [ ] **Step 3: Implement**

`packages/core/src/ports.ts` — append:

```ts
export interface ClientInfo {
  readonly clientId: string;
  readonly quotaPerHour: number;
}

export interface KeyStore {
  /** The client a presented API key belongs to, or null when unknown or revoked. */
  verify(presentedKey: string): Promise<ClientInfo | null>;
}
```

`packages/core/src/auth/keys.ts`:

```ts
import type { ClientInfo, KeyStore } from '../ports';

export const KEY_PREFIX = 'rirmcp_';
export const KEY_RE = /^rirmcp_[A-Za-z0-9_-]{43}$/;
/** Opaque, log-safe client identifiers: never a person's name or email. */
export const CLIENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_QUOTA_PER_HOUR = 60;
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
    if (!Number.isInteger(o.quotaPerHour) || (o.quotaPerHour as number) < 1) throw bad('quotaPerHour must be a positive integer');
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
```

`packages/core/src/index.ts` — add:

```ts
export {
  CLIENT_ID_RE, constantTimeEqual, DEFAULT_QUOTA_PER_HOUR, generateKey, KEY_RE, parseKeyRecords,
  RecordKeyStore, sha256Hex, SingleKeyStore, type KeyRecord,
} from './auth/keys';
```

and extend the ports export line with `type ClientInfo, type KeyStore`.

- [ ] **Step 4: Run tests, typecheck**

Run: `corepack pnpm vitest run packages/core/test/auth/keys.test.ts && corepack pnpm typecheck`
Expected: PASS; tsc prints nothing.

- [ ] **Step 5: Commit** — `feat(core): add API key format, hashing and key stores`

---

### Task 2: ClientGate port and memory implementation (core)

**Files:**
- Create: `packages/core/src/memory/client-gate.ts`
- Modify: `packages/core/src/ports.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/memory/client-gate.test.ts`

**Interfaces:**
- Consumes: `Clock` (ports).
- Produces:
  - `type GateResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'quota' | 'suspended'; readonly retryAfterS: number }`
  - `interface ClientGate { charge(client: ClientInfo, weight: number): Promise<GateResult>; observe(client: ClientInfo, unit: string): Promise<GateResult> }`
  - `const SCAN_THRESHOLD = 200`, `const SUSPEND_MS = 86_400_000`
  - `class MemoryClientGate implements ClientGate { constructor(clock: Clock, opts?: { onSuspend?: (clientId: string) => void; scanThreshold?: number; suspendMs?: number }) }`

Semantics:
- Fixed hourly window per client (same style as `MemoryRateLimiter`): `charge` denies when `used + weight > quotaPerHour`; `retryAfterS` = seconds to window end. Denied charges are not counted.
- `observe` adds a salted SHA-256 digest (16 hex chars, random per-process salt) of `unit` to the client's per-window set; the raw unit is never stored. When the set size exceeds `scanThreshold` the client is suspended for `suspendMs`, `onSuspend(clientId)` fires once, and that `observe` returns `suspended`.
- While suspended, both `charge` and `observe` return `{ ok: false, reason: 'suspended', retryAfterS }`.
- A new window clears `used` and the set.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { MemoryClientGate } from '../../src/memory/client-gate';
import { FakeClock } from '../support/fake-clock';

const alpha = { clientId: 'alpha', quotaPerHour: 10 };
const beta = { clientId: 'beta', quotaPerHour: 10 };

describe('MemoryClientGate quota', () => {
  it('allows weighted charges up to the hourly quota, per client', async () => {
    const g = new MemoryClientGate(new FakeClock());
    expect(await g.charge(alpha, 5)).toEqual({ ok: true });
    expect(await g.charge(alpha, 5)).toEqual({ ok: true });
    const denied = await g.charge(alpha, 1);
    expect(denied).toMatchObject({ ok: false, reason: 'quota' });
    expect((denied as { retryAfterS: number }).retryAfterS).toBe(3600);
    expect(await g.charge(beta, 1)).toEqual({ ok: true });
  });

  it('does not count denied charges and resets after the hour', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock);
    await g.charge(alpha, 9);
    expect((await g.charge(alpha, 5)).ok).toBe(false);
    expect((await g.charge(alpha, 1)).ok).toBe(true);
    clock.advance(3_600_000);
    expect((await g.charge(alpha, 10)).ok).toBe(true);
  });
});

describe('MemoryClientGate scan detector', () => {
  it('counts distinct units, suspends above the threshold and alerts once', async () => {
    const clock = new FakeClock();
    const alerts: string[] = [];
    const g = new MemoryClientGate(clock, { scanThreshold: 3, onSuspend: (id) => alerts.push(id) });
    for (const u of ['v4:1.1.1.0/24', 'v4:1.1.1.0/24', 'v4:1.1.2.0/24', 'as:4608']) expect((await g.observe(alpha, u)).ok).toBe(true);
    expect(await g.observe(alpha, 'as:15169')).toMatchObject({ ok: false, reason: 'suspended' });
    expect(await g.charge(alpha, 1)).toMatchObject({ ok: false, reason: 'suspended' });
    expect(await g.observe(alpha, 'as:1')).toMatchObject({ ok: false, reason: 'suspended' });
    expect(alerts).toEqual(['alpha']);
    expect((await g.observe(beta, 'as:15169')).ok).toBe(true);
  });

  it('lifts the suspension after suspendMs and starts a fresh count', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock, { scanThreshold: 1, suspendMs: 60_000 });
    await g.observe(alpha, 'a');
    expect((await g.observe(alpha, 'b')).ok).toBe(false);
    clock.advance(60_000);
    expect((await g.observe(alpha, 'c')).ok).toBe(true);
  });

  it('clears the distinct set when the hour rolls over', async () => {
    const clock = new FakeClock();
    const g = new MemoryClientGate(clock, { scanThreshold: 2 });
    await g.observe(alpha, 'a');
    await g.observe(alpha, 'b');
    clock.advance(3_600_000);
    expect((await g.observe(alpha, 'c')).ok).toBe(true);
    expect((await g.observe(alpha, 'd')).ok).toBe(true);
  });

  it('never stores the raw unit', async () => {
    const g = new MemoryClientGate(new FakeClock());
    await g.observe(alpha, 'v4:203.0.113.0/24');
    expect(JSON.stringify([...(g as unknown as { state: Map<string, { units: Set<string> }> }).state.values()].map((s) => [...s.units]))).not.toContain('203.0.113');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `corepack pnpm vitest run packages/core/test/memory/client-gate.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

`ports.ts` — append:

```ts
export type GateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'quota' | 'suspended'; readonly retryAfterS: number };

/** Per-client anti-harvesting controls (spec §7): hourly upstream quota and scan detection. */
export interface ClientGate {
  /** Charge `weight` upstream calls to the client's hourly quota. Denied charges are not counted. */
  charge(client: ClientInfo, weight: number): Promise<GateResult>;
  /** Record one distinct /24, /48, ASN or handle queried this hour; suspends the client above the threshold. */
  observe(client: ClientInfo, unit: string): Promise<GateResult>;
}
```

`packages/core/src/memory/client-gate.ts`:

```ts
import type { ClientGate, ClientInfo, Clock, GateResult } from '../ports';

export const SCAN_THRESHOLD = 200;
export const SUSPEND_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const OK: GateResult = { ok: true };

interface ClientState {
  windowStart: number;
  used: number;
  units: Set<string>;
  suspendedUntil: number;
}

export interface ClientGateOptions {
  readonly onSuspend?: (clientId: string) => void;
  readonly scanThreshold?: number;
  readonly suspendMs?: number;
}

export class MemoryClientGate implements ClientGate {
  private readonly state = new Map<string, ClientState>();
  private readonly clock: Clock;
  private readonly opts: Required<Pick<ClientGateOptions, 'scanThreshold' | 'suspendMs'>> & ClientGateOptions;
  private readonly salt = crypto.getRandomValues(new Uint8Array(16)).join('.');

  constructor(clock: Clock, opts: ClientGateOptions = {}) {
    this.clock = clock;
    this.opts = { scanThreshold: SCAN_THRESHOLD, suspendMs: SUSPEND_MS, ...opts };
  }

  async charge(client: ClientInfo, weight: number): Promise<GateResult> {
    const now = this.clock.now();
    const s = this.current(client.clientId, now);
    if (now < s.suspendedUntil) return this.suspended(s, now);
    if (s.used + weight > client.quotaPerHour) {
      return { ok: false, reason: 'quota', retryAfterS: Math.ceil((s.windowStart + HOUR_MS - now) / 1000) };
    }
    s.used += weight;
    return OK;
  }

  async observe(client: ClientInfo, unit: string): Promise<GateResult> {
    const now = this.clock.now();
    const s = this.current(client.clientId, now);
    if (now < s.suspendedUntil) return this.suspended(s, now);
    s.units.add(await this.digest(unit));
    if (s.units.size <= this.opts.scanThreshold) return OK;
    s.suspendedUntil = now + this.opts.suspendMs;
    try { this.opts.onSuspend?.(client.clientId); } catch { /* alerting must not break answering */ }
    return this.suspended(s, now);
  }

  private current(clientId: string, now: number): ClientState {
    let s = this.state.get(clientId);
    if (!s) {
      s = { windowStart: now, used: 0, units: new Set(), suspendedUntil: 0 };
      this.state.set(clientId, s);
    }
    if (now >= s.suspendedUntil && s.suspendedUntil !== 0) {
      s.suspendedUntil = 0;
      s.windowStart = now;
      s.used = 0;
      s.units.clear();
    }
    if (now - s.windowStart >= HOUR_MS) {
      s.windowStart = now;
      s.used = 0;
      s.units.clear();
    }
    return s;
  }

  private suspended(s: ClientState, now: number): GateResult {
    return { ok: false, reason: 'suspended', retryAfterS: Math.ceil((s.suspendedUntil - now) / 1000) };
  }

  /** Salted, truncated digest: distinct counting without keeping the queried value. */
  private async digest(unit: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.salt}|${unit}`));
    return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  }
}
```

`index.ts` — add `export { MemoryClientGate, SCAN_THRESHOLD, SUSPEND_MS } from './memory/client-gate';` and `type ClientGate, type GateResult` to the ports export.

- [ ] **Step 4: Run tests, typecheck** — PASS.
- [ ] **Step 5: Commit** — `feat(core): add per-client quota and scan detector gate`

---

### Task 3: Client-scoped service (core)

**Files:**
- Create: `packages/core/src/service/scan-unit.ts`
- Modify: `packages/core/src/service/service.ts`, `packages/core/src/service/fetcher.ts`, `packages/core/src/service/answer.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/service/client-scope.test.ts`, `packages/core/test/service/scan-unit.test.ts`

**Interfaces:**
- Consumes: `ClientGate`, `ClientInfo`, `GateResult` (Task 2).
- Produces:
  - `interface ClientScope { readonly client: ClientInfo; readonly gate: ClientGate }` (exported from `service.ts` and `index.ts`)
  - `RirService.forClient(scope: ClientScope): RirService` — shares cache, bootstrap, fetcher (and its in-flight coalescing) with the parent.
  - `FetchRequest.scope?: ClientScope`
  - `ErrorCode` gains `'quota_exceeded' | 'suspended'`.
  - `scanUnitForIp(p: IpPrefix): string` → `v4:<a.b.c.0/24>` (or the prefix itself when shorter than /24), `v6:<x:y:z::/48>` (or shorter prefix); `scanUnitForAsn(n: number): string` → `as:<n>`; `scanUnitForHandle(rir: Rir, h: string): string` → `h:<rir>:<handle>`.

Behaviour:
- Every public method on a scoped service calls `gate.observe` with the query's scan unit after parsing and the special-use check, before bootstrap routing. A denied observe returns `{ kind: 'error', code: 'suspended', message: 'This API key is suspended for unusual query volume; contact the operator.' }`. Special-use answers never observe.
- `CachedFetcher.refresh` charges `scope.gate.charge(scope.client, req.weight)` before `limiter.acquire`. Denied → stale fallback if any, else `quota_exceeded` (`Hourly lookup quota for this API key is used up; cached answers still work. Retry in Ns.`) or `suspended`. Fresh cache hits and coalesced in-flight requests never charge.
- An unscoped service (stdio) behaves exactly as today.

- [ ] **Step 1: Write the failing tests**

`scan-unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseIpOrCidr } from '../../src/input/ip';
import { scanUnitForAsn, scanUnitForHandle, scanUnitForIp } from '../../src/service/scan-unit';

describe('scan units', () => {
  it.each([
    ['1.1.1.1', 'v4:1.1.1.0/24'],
    ['1.1.1.128/25', 'v4:1.1.1.0/24'],
    ['1.1.0.0/16', 'v4:1.1.0.0/16'],
    ['2001:db8:1:2::1', 'v6:2001:db8:1::/48'],
    ['2001:db8::/32', 'v6:2001:db8::/32'],
  ])('%s -> %s', (input, unit) => {
    expect(scanUnitForIp(parseIpOrCidr(input))).toBe(unit);
  });
  it('formats ASN and handle units', () => {
    expect(scanUnitForAsn(4608)).toBe('as:4608');
    expect(scanUnitForHandle('apnic', 'ORG-ARAD1-AP')).toBe('h:apnic:ORG-ARAD1-AP');
  });
});
```

`client-scope.test.ts` (uses existing fixtures/support):

```ts
import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../src/memory/cache';
import { MemoryClientGate } from '../../src/memory/client-gate';
import { MemoryRateLimiter } from '../../src/memory/rate-limiter';
import { DEFAULT_LIMITS } from '../../src/rdap/limits';
import { RirService } from '../../src/service/service';
import { FakeClock } from '../support/fake-clock';
import { fakeFetch } from '../support/fake-fetch';
import { ianaRoutes, loadFixture } from '../support/fixtures';

const IP = 'https://rdap.apnic.net/ip/1.1.1.1';
const AS = 'https://rdap.apnic.net/autnum/4608';

function setup(quotaPerHour = 1, scanThreshold = 200) {
  const clock = new FakeClock();
  const fetch = fakeFetch({
    ...ianaRoutes(),
    [IP]: { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
    [AS]: { body: loadFixture('rdap/apnic/autnum/4608.json') },
  });
  const base = new RirService({ fetch, clock, userAgent: 't', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
  const gate = new MemoryClientGate(clock, { scanThreshold });
  const scoped = base.forClient({ client: { clientId: 'alpha', quotaPerHour }, gate });
  return { clock, fetch, base, scoped, gate };
}

describe('client-scoped service', () => {
  it('charges the quota on upstream calls only; cache hits stay free after the quota is spent', async () => {
    const { scoped } = setup(1);
    expect((await scoped.ip('1.1.1.1')).kind).toBe('record');
    const again = await scoped.ip('1.1.1.1');
    expect(again.kind === 'record' && again.meta.cache).toBe('hit');
    const other = await scoped.asn('AS4608');
    expect(other).toMatchObject({ kind: 'error', code: 'quota_exceeded' });
  });

  it('shares the cache with the parent and other clients', async () => {
    const { base, scoped } = setup(1);
    await base.asn('AS4608');
    expect((await scoped.asn('AS4608')).kind).toBe('record');
    expect((await scoped.ip('1.1.1.1')).kind).toBe('record');
  });

  it('suspends a client that queries more distinct units than the threshold', async () => {
    const { scoped } = setup(100, 1);
    expect((await scoped.ip('1.1.1.1')).kind).toBe('record');
    expect(await scoped.asn('AS4608')).toMatchObject({ kind: 'error', code: 'suspended' });
    expect(await scoped.ip('1.1.1.1')).toMatchObject({ kind: 'error', code: 'suspended' });
  });

  it('never observes or charges special-use answers', async () => {
    const { scoped, fetch } = setup(0, 0);
    expect((await scoped.ip('10.0.0.1')).kind).toBe('special');
    expect((await scoped.asn('AS64512')).kind).toBe('special');
    expect(fetch.inits).toHaveLength(0);
  });

  it('leaves the unscoped service unlimited', async () => {
    const { base } = setup(0, 0);
    expect((await base.ip('1.1.1.1')).kind).toBe('record');
    expect((await base.asn('AS4608')).kind).toBe('record');
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (`forClient` / module missing).

- [ ] **Step 3: Implement**

`scan-unit.ts`:

```ts
import { formatCidr, type IpPrefix } from '../input/ip';
import type { Rir } from '../rdap/rirs';

/** Scan detector units (spec §7): the covering /24 (v4) or /48 (v6), or the prefix itself when shorter. */
export function scanUnitForIp(p: IpPrefix): string {
  const bits = p.family === 4 ? 32 : 128;
  const unitLen = p.family === 4 ? 24 : 48;
  const length = Math.min(p.length, unitLen);
  const host = BigInt(bits - length);
  return `v${p.family}:${formatCidr({ family: p.family, value: (p.value >> host) << host, length })}`;
}

export const scanUnitForAsn = (n: number): string => `as:${n}`;
export const scanUnitForHandle = (rir: Rir, handle: string): string => `h:${rir}:${handle}`;
```

(Check `formatCidr` always prints `/len`; if it does not for host routes, use `formatAddress(...)` + `/${length}`.)

`answer.ts`: add `| 'quota_exceeded' | 'suspended'` to `ErrorCode`.

`fetcher.ts`:
- `import type { ClientScope } from './service';` would create a cycle — instead define `ClientScope` in `fetcher.ts` and re-export it from `service.ts`:

```ts
export interface ClientScope {
  readonly client: ClientInfo;
  readonly gate: ClientGate;
}
```

- `FetchRequest` gains `readonly scope?: ClientScope;`
- Add:

```ts
export function gateDenied(g: Exclude<GateResult, { ok: true }>): Extract<FetchOutcome<never>, { ok: false }> {
  return g.reason === 'quota'
    ? { ok: false, code: 'quota_exceeded', message: `Hourly lookup quota for this API key is used up; cached answers still work. Retry in ${g.retryAfterS}s.`, retryAfterS: g.retryAfterS }
    : { ok: false, code: 'suspended', message: 'This API key is suspended for unusual query volume; contact the operator.', retryAfterS: g.retryAfterS };
}
```

- In `refresh`, before `limiter.acquire`:

```ts
    if (req.scope) {
      const g = await req.scope.gate.charge(req.scope.client, req.weight);
      if (!g.ok) return fallback ?? gateDenied(g);
    }
```

`service.ts`:
- Constructor becomes `constructor(deps: ServiceDeps, shared?: { bootstrap: Bootstrap; fetcher: CachedFetcher }, scope?: ClientScope)`; reuse `shared` when given. Keep `deps` in a private field.
- `forClient(scope: ClientScope): RirService { return new RirService(this.deps, { bootstrap: this.bootstrap, fetcher: this.fetcher }, scope); }`
- Private helpers:

```ts
  private async admit(unit: string): Promise<NoRecord | null> {
    if (!this.scope) return null;
    const g = await this.scope.gate.observe(this.scope.client, unit);
    if (g.ok) return null;
    const { code, message, retryAfterS } = gateDenied(g);
    return { kind: 'error', code, message, retryAfterS };
  }

  private get<T>(req: FetchRequest<T>): Promise<FetchOutcome<T>> {
    return this.fetcher.get(this.scope ? { ...req, scope: this.scope } : req);
  }
```

- In `ip`, `reverseDns`, `historyTarget` (ip branch): after the special-use check, `const denied = await this.admit(scanUnitForIp(p)); if (denied) return denied;`
- In `asn` and the asn branch of `historyTarget`: same with `scanUnitForAsn(n)`.
- In `entity`: after resolving `rir`, `admit(scanUnitForHandle(rir, handle))`.
- Replace every `this.fetcher.get(` with `this.get(`.

`index.ts`: export `type ClientScope` from `./service/service`.

- [ ] **Step 4: Run all tests, typecheck** — `corepack pnpm test && corepack pnpm typecheck` → PASS; `service.ts` stays < 400 lines (purity test).
- [ ] **Step 5: Commit** — `feat(core): scope the service to a client with quota and scan checks`

---

### Task 4: Call log hook (core)

**Files:**
- Modify: `packages/core/src/tools.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/server.test.ts`

**Interfaces:**
- Produces: `interface CallLog { readonly tool: (typeof TOOL_NAMES)[number]; readonly outcome: 'record' | 'special' | ErrorCode | 'internal'; readonly rir?: Rir; readonly cache?: 'miss' | 'hit' | 'stale'; readonly ms: number }` and `ServerHooks.onCall?: (log: CallLog) => void`. Never carries query values.

- [ ] **Step 1: Failing test** — in `server.test.ts`, let `connect(hooks?)` pass hooks to `createServer`; add:

```ts
  it('reports each call to onCall without the query value', async () => {
    const logs: unknown[] = [];
    const c = await connect({ onCall: (l) => logs.push(l) });
    await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } });
    await c.callTool({ name: 'rdap_asn_lookup', arguments: { asn: 'AS-FOO' } });
    expect(logs).toMatchObject([
      { tool: 'rdap_ip_lookup', outcome: 'record', rir: 'apnic', cache: 'miss' },
      { tool: 'rdap_asn_lookup', outcome: 'invalid_input' },
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/1\.1\.1|AS-FOO/);
    for (const l of logs) expect(typeof (l as { ms: number }).ms).toBe('number');
  });
```

- [ ] **Step 2: Run** — FAIL (`onCall` never called).
- [ ] **Step 3: Implement** — wrap each tool body in `observed(tool, hooks, fn)` where `fn` returns `{ out: ToolResult; answer?: Answer<unknown> }`; compute `outcome` from `answer.kind` / `answer.code` (`'internal'` when `safely` caught an exception), take `rir`/`cache` from `answer.meta`, `ms = Math.round(performance.now() - t0)`; call `hooks.onCall` inside `try/catch` so a failing hook never breaks the answer. Export `type CallLog`.
- [ ] **Step 4: Run tests, typecheck** — PASS.
- [ ] **Step 5: Commit** — `feat(core): report value-free per-call logs through a server hook`

---

### Task 5: HTTP configuration (node)

**Files:**
- Modify: `packages/node/src/config.ts`
- Test: `packages/node/test/config.test.ts`

**Interfaces:**
- Consumes: `SingleKeyStore`, `RecordKeyStore`, `parseKeyRecords`, `DEFAULT_QUOTA_PER_HOUR`, `KeyStore` (Task 1).
- Produces:

```ts
export interface HttpConfig extends NodeConfig {
  readonly host: string;            // RIR_MCP_HTTP_HOST, default 127.0.0.1
  readonly port: number;            // RIR_MCP_HTTP_PORT, default 4608
  readonly allowedHosts: string[];  // RIR_MCP_ALLOWED_HOSTS (comma list); default localhost names when host is loopback; required otherwise
  readonly allowedOrigins: string[];// RIR_MCP_ALLOWED_ORIGINS (comma list of hostnames); default localhostAllowedOrigins()
  readonly keyStore: KeyStore;
  readonly authMode: 'per-user' | 'single';
}
export function loadHttpConfig(env: Env, readFile: (path: string) => string): HttpConfig;
```

Rules: `RIR_MCP_KEYS_FILE` (JSON array, Task 1 format) wins over `RIR_MCP_API_KEY`; `RIR_MCP_QUOTA_PER_HOUR` (positive integer, default 60) applies to single-key mode; neither key source → `ConfigError('HTTP needs RIR_MCP_KEYS_FILE or RIR_MCP_API_KEY; refusing to start without authentication.')`; unreadable/invalid keys file → `ConfigError` naming the file and the parse problem but never its contents; port must be an integer 1–65535 (0 allowed for tests); a non-loopback host (anything other than `127.0.0.1`, `::1`, `localhost`) without `RIR_MCP_ALLOWED_HOSTS` → `ConfigError`.

- [ ] **Step 1: Failing tests** — table-driven cases covering: defaults; keys file precedence (both set → `authMode 'per-user'`); fail closed (neither); bad key format; bad keys file JSON (message contains the path, not the content); non-loopback without allowed hosts; non-loopback with allowed hosts; bad port; bad quota; and that `RIR_MCP_OPERATOR` is still required.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** in `config.ts` (keep `loadConfig` unchanged; `loadHttpConfig` calls it first). Import `localhostAllowedOrigins`, `localhostAllowedHostnames` from `@modelcontextprotocol/server`.
- [ ] **Step 4: Run tests, typecheck** — PASS.
- [ ] **Step 5: Commit** — `feat(node): load HTTP config with fail-closed auth selection`

---

### Task 6: Streamable HTTP server (node)

**Files:**
- Create: `packages/node/src/http-bridge.ts` (node:http ↔ web Request/Response)
- Create: `packages/node/src/http-app.ts` (request gate + MCP handler, runtime-neutral fetch function)
- Create: `packages/node/src/http.ts` (entry point)
- Test: `packages/node/test/http.test.ts`

**Interfaces:**
- Consumes: `HttpConfig` (Task 5), `RirService.forClient` (Task 3), `MemoryClientGate` (Task 2), `ServerHooks.onCall` (Task 4).
- Produces:
  - `createHttpApp(opts: { service: RirService; gate: ClientGate; keyStore: KeyStore; allowedHosts: string[]; allowedOrigins: string[]; log: (line: Record<string, unknown>) => void; onError?: (err: unknown) => void }): { fetch(req: Request): Promise<Response>; close(): Promise<void> }`
  - `toWebRequest(req: IncomingMessage, origin: string): Request`; `sendWebResponse(res: ServerResponse, r: Response): Promise<void>`
  - `startHttp(config: HttpConfig, app): Promise<{ port: number; close(): Promise<void> }>`

Request pipeline in `createHttpApp().fetch`, in order:
1. Path must be `/mcp` → else 404 (`{"error":"not_found"}`).
2. `hostHeaderValidationResponse(req, allowedHosts)` → 403 when the Host is not allowed.
3. `originValidationResponse(req, allowedOrigins)` → 403 when Origin present and not allowed.
4. Bearer: `requireBearerAuth({ verifier })` where `verifier.verifyAccessToken(token)` calls `keyStore.verify(token)`; null → `throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid API key')`; success → `AuthInfo { token: '', clientId, scopes: [], expiresAt: <now + 1 h, seconds>, extra: { quotaPerHour } }` (token blanked so it cannot be logged downstream).
5. `handler.fetch(req, { authInfo })` with `createMcpHandler(factory, { maxRequestBodySize: 65_536, responseMode: 'json', onerror })`; the factory reads `ctx.authInfo` and returns `createServer(service.forClient({ client: { clientId, quotaPerHour }, gate }), { onError, onCall: (l) => log({ ...l, client: clientId }) })`.
6. Every rejection logs `{ t, status, reason }` (reason ∈ `not_found | bad_host | bad_origin | unauthorized`) — no header values.

`http.ts` entry: `setDefaultAutoSelectFamilyAttemptTimeout(2000)`; `loadHttpConfig(process.env, (p) => readFileSync(p, 'utf8'))` (ConfigError → stderr + exit 1); build `RirService` exactly as `stdio.ts` does; `MemoryClientGate(systemClock, { onSuspend: (id) => console.error(JSON.stringify({ t: ..., alert: 'client_suspended', client: id })) })`; `node:http` server with `requestTimeout: 30_000`, `headersTimeout: 10_000`, `keepAliveTimeout: 5_000`; listen on `host:port`; log `rir-mcp: listening on http://host:port/mcp (auth: per-user|single)`; SIGINT/SIGTERM → close.

- [ ] **Step 1: Failing tests** — `http.test.ts` starts `startHttp` on port 0 with a fake-fetch-backed service and a `SingleKeyStore`, then:

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
// ...
it('serves tools to a client with a valid key', async () => {
  const c = new Client({ name: 't', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }));
  expect((await c.listTools()).tools).toHaveLength(5);
  const r = await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } });
  expect(JSON.stringify(r.content)).toContain('APNIC');
  await c.close();
});

it.each([
  ['no key', {}, 401],
  ['wrong key', { authorization: `Bearer rirmcp_${'B'.repeat(43)}` }, 401],
  ['foreign origin with a valid key', { authorization: `Bearer ${KEY}`, origin: 'https://evil.example' }, 403],
  ['null origin', { authorization: `Bearer ${KEY}`, origin: 'null' }, 403],
])('rejects %s', async (_name, headers, status) => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: INIT });
  expect(res.status).toBe(status);
});

it('returns 404 off /mcp and 413 for an oversized body', async () => {
  expect((await fetch(`${base}/other`)).status).toBe(404);
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70_000) } });
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: big });
  expect(res.status).toBe(413);
});

it('logs calls with clientId and without query values or keys', async () => {
  // connect + call as above, then:
  const text = JSON.stringify(logs);
  expect(text).toContain('"client":"default"');
  expect(text).not.toMatch(/1\.1\.1\.1|rirmcp_/);
});
```

`INIT` is a minimal JSON-RPC `initialize` request body. Use `allowedHosts: ['127.0.0.1', 'localhost']`.

- [ ] **Step 2: Run** — FAIL (modules missing).
- [ ] **Step 3: Implement** the three files. In `http-bridge.ts` build the `Request` with `body: Readable.toWeb(req)` and `duplex: 'half'` for non-GET/HEAD; copy headers (joining arrays with `, `); in `sendWebResponse` write status + headers, then pipe `Readable.fromWeb(r.body)` to `res` (or `res.end()` when no body).
- [ ] **Step 4: Run all tests, typecheck** — PASS.
- [ ] **Step 5: Manual smoke** — `RIR_MCP_OPERATOR=https://github.com/IEISI-ORG/rir-mcp/issues RIR_MCP_API_KEY=$(corepack pnpm -s tsx scripts/keys.ts new --raw) node_modules/.bin/tsx packages/node/src/http.ts` then `curl -i -X POST localhost:4608/mcp` → 401.
- [ ] **Step 6: Commit** — `feat(node): serve rir-mcp over authenticated Streamable HTTP`

---

### Task 7: CLI dispatch and key tool (node + scripts)

**Files:**
- Create: `packages/node/src/cli.ts`
- Create: `scripts/keys.ts`
- Modify: `packages/node/package.json` (`"bin": { "rir-mcp": "./src/cli.ts" }`), `package.json` (`"keys": "tsx scripts/keys.ts"`)
- Test: `packages/node/test/cli.test.ts`, `packages/core/test/auth/keys.test.ts` (no new core code)

**Interfaces:**
- `cli.ts`: `--stdio` (default) imports `./stdio`; `--http` imports `./http`; anything else → usage on stderr, exit 2.
- `scripts/keys.ts new <clientId> [quotaPerHour]` → prints the new key on stdout line 1 and the keys-file JSON record on line 2; `--raw` prints only a key (single-key mode). Validates `clientId` with `CLIENT_ID_RE`. `scripts/keys.ts hash <key>` prints the SHA-256 hex.

- [ ] **Step 1: Failing test** — `cli.test.ts` spawns `tsx packages/node/src/cli.ts --bogus` and expects exit code 2 and `usage:` on stderr with empty stdout.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `cli.ts` and `scripts/keys.ts`.
- [ ] **Step 4: Run tests; manually run `node_modules/.bin/tsx scripts/keys.ts new acme 60`** and check the record parses with `parseKeyRecords([record])`.
- [ ] **Step 5: Commit** — `feat(node): add --stdio/--http CLI and API key tool`

---

### Task 8: Documentation

**Files:**
- Modify: `docs/deployment.md` (new "Self-hosted HTTP" section), `README.md` (HTTP mode one-liner), `docs/superpowers/plans/2026-09-30-rir-mcp-plan-1-followups.md` (move resolved items)

Content for `deployment.md`:
- Generate keys (`scripts/keys.ts`), single-key vs keys-file modes, precedence, fail-closed behaviour.
- Environment variable table: `RIR_MCP_OPERATOR`, `RIR_MCP_API_KEY`, `RIR_MCP_KEYS_FILE`, `RIR_MCP_QUOTA_PER_HOUR`, `RIR_MCP_HTTP_HOST`, `RIR_MCP_HTTP_PORT`, `RIR_MCP_ALLOWED_HOSTS`, `RIR_MCP_ALLOWED_ORIGINS`.
- Public binding: put TLS in front (reverse proxy); set `RIR_MCP_ALLOWED_HOSTS` to the public hostname.
- Quota (60 upstream calls/h, cache hits free) and scan detector (200 distinct units/h → 24 h suspension, alert line on stderr); revocation = edit keys file + restart.
- What is logged (one JSON line per call to stderr) and what never is.
- Client config example with `Authorization: Bearer`.

- [ ] **Step 1:** Write the docs. **Step 2:** `corepack pnpm test && corepack pnpm typecheck`. **Step 3: Commit** — `docs: document self-hosted HTTP mode`

---

## Self-review notes

- Spec §7 "Keys: only hashes stored (per-user mode)" → Task 1 `RecordKeyStore`; single-key mode holds the hash of the env key, not the key.
- Spec §7 "Origin 403" → Task 6 step 3; Host validation added (DNS rebinding) — not in spec, required by Review Focus 4.
- Spec §7 "deny-list in StateDO" is Worker-only → Plan 3.
- Spec §9 "Auth: mode selection incl. fail-closed; revoked key; constant-time compare" → Tasks 1 and 5.
- Spec §10 Docker → deferred to Plan 4 (packaging/CI); noted in QUESTIONS.md.
