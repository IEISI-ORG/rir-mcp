# rir-mcp Plan 1: Core + Node stdio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working local MCP server (stdio) that answers IP, ASN, entity, reverse-DNS and APNIC-history questions from all five RIRs via RDAP, with PII-free reduction before caching, per-RIR rate limits, and token-lean text output.

**Architecture:** A runtime-agnostic `@ieisi/rir-mcp-core` package (input parsing → special-use check → cache → rate limiter → IANA bootstrap routing → RDAP fetch → reduce → render) exposed as five MCP tools via the MCP TypeScript SDK v2; a thin `@ieisi/rir-mcp-node` package serves it over stdio with in-memory cache and limiter. Node HTTP/auth (Plan 2), Cloudflare Worker (Plan 3) and governance files (Plan 4) are out of scope.

**Tech Stack:** TypeScript 7, pnpm 12 workspaces, vitest 5, zod 4 (`zod/v4`), `@modelcontextprotocol/server` + `@modelcontextprotocol/client` 2.2.x, tsx 4 (runs TS directly; no build step in Plan 1), Node ≥ 22.

**Spec:** `docs/superpowers/specs/2026-09-30-rir-mcp-core-design.md` (sources: `docs/BIBLIOGRAPHY.md`). Read spec §4–§6 and §9 before starting.

## Global Constraints

- Packages: `@modelcontextprotocol/server` and `@modelcontextprotocol/client` `^2.2.0`. **Never** add the v1 package `@modelcontextprotocol/sdk`.
- zod `^4.6.5`, always imported as `import * as z from 'zod/v4';`.
- `packages/core/src/**` must not import `node:*` modules or use `Buffer`/`process` (enforced by a test in Task 12). Tests and scripts may.
- Every file under 400 lines. Conventional Commits; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Rendered current-record text < 600 bytes; history summary < 1,500 bytes (spec §1 criterion 2).
- No personal data returned, cached, logged or committed: reducers run before the cache; any entity whose vCard `kind` is not `org` or `group` is treated as a person.
- Default per-RIR limits (also the maximum): APNIC/ARIN/RIPE/AFRINIC 1 req/s, burst 5; LACNIC 10/min, burst 3, 1,000/hour. Weights: current lookup 1, history 5. On upstream 429/5xx/timeout/bad response: rate × 0.5 for 5 minutes.
- TTLs: current 1 h fresh / 24 h stale; not-found 15 min; history 7 days fresh / 30 days stale; IANA bootstrap 24 h / 7 days.
- User-Agent: `rir-mcp/<version> (+https://github.com/IEISI-ORG/rir-mcp; operator=<contact>)`; the server refuses to start without an operator contact.
- Only `https://` bootstrap base URLs; at most one redirect, and only to a host listed in the IANA bootstrap.
- Handle syntax: `^[A-Z0-9][A-Z0-9-]{0,63}$` after trim + upper-case.
- No search, wildcard or batch tools. Tool names, in this order: `rdap_ip_lookup`, `rdap_asn_lookup`, `rdap_entity_lookup`, `rdap_reverse_dns`, `rdap_history`.

## Review Focus

1. **A registry returns a personal abuse contact** (LACNIC and AFRINIC do): output must say `personal contact, not disclosed; see <network RDAP URL>` and never show the person's name or handle → test in Task 9.
2. **Messy human input** (`" AS 4608 "`, `AS04608`, `2001:DB8::1`, `1.1.1.1/24` with host bits, `010.1.1.1`, `fe80::1%eth0`) → canonical form or a clear error that shows an accepted example → tests in Tasks 1–2 and Task 12.
3. **An address outside every RIR's IANA delegation** (e.g. `4000::1`) → `not_delegated` answer with zero RDAP calls → test in Task 11.
4. **Upstream returns 200 with an HTML challenge page, or 403** (the RIRs sit behind Cloudflare) → treated as an upstream failure: limiter penalised, stale answer served if any, nothing cached → tests in Tasks 5 and 11.
5. **A burst of identical questions on a cold cache, or an exhausted limiter with a stale entry** → one upstream call; stale answer labelled `STALE` instead of an error → tests in Task 11.

---

## File map

```
package.json  pnpm-workspace.yaml  tsconfig.json  vitest.config.ts  .gitignore  README.md
fixtures/iana/{ipv4,ipv6,asn}.json            recorded IANA bootstrap (Task 7)
fixtures/rdap/<rir>/<kind>/<case>.json         recorded + scrubbed RDAP (Task 7)
scripts/fixtures-record.ts                     (Task 7)
packages/core/
  package.json
  src/version.ts                               VERSION                              (T5)
  src/ports.ts                                 FetchLike, Clock, CacheStore, RateLimiter (T4)
  src/special-use.ts                           IANA special-purpose tables          (T3)
  src/input/errors.ts, ip.ts                   InputError, IP parsing/formatting    (T1)
  src/input/asn.ts, handle.ts, reverse-zone.ts                                      (T2)
  src/rdap/rirs.ts                             Rir, labels, hosts                   (T2)
  src/rdap/limits.ts                           LimitProfile, DEFAULT_LIMITS         (T4)
  src/rdap/errors.ts, client.ts, user-agent.ts RdapError, fetchJson, UA             (T5)
  src/rdap/bootstrap.ts                        IANA bootstrap router                (T6)
  src/memory/cache.ts, rate-limiter.ts         in-memory backends                   (T4)
  src/reduce/vcard.ts                          jCard helpers, isPersonLike          (T7)
  src/reduce/sanitize.ts, util.ts, entities.ts, types.ts,
             network.ts, autnum.ts, entity.ts, domain.ts                            (T8)
  src/reduce/history.ts                        history reduction + views            (T10)
  src/service/answer.ts                        Meta, Answer, ErrorCode              (T9)
  src/render/format.ts, text.ts                text renderers                       (T9)
  src/render/history.ts                        history renderer                     (T10)
  src/service/fetcher.ts, service.ts           cache/limiter/fetch pipeline         (T11)
  src/guide/text.ts, tools.ts, server.ts, index.ts                                  (T12)
  test/support/fake-clock.ts (T4), fake-fetch.ts (T5), fixtures.ts, scrub.ts (T7)
  test/**/*.test.ts
packages/node/
  package.json, src/config.ts, src/stdio.ts, test/*.test.ts                         (T13)
```

---

### Task 1: Workspace scaffold + IP parsing

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `packages/core/package.json`
- Create: `packages/core/src/input/errors.ts`, `packages/core/src/input/ip.ts`
- Test: `packages/core/test/input/ip.test.ts`

**Interfaces:**
- Produces: `class InputError extends Error { readonly hint: string }`; `type IpFamily = 4 | 6`; `interface IpPrefix { family: IpFamily; value: bigint; length: number }` (host bits zeroed); `parseIpOrCidr(raw: string): IpPrefix` (throws `InputError`); `formatAddress(family, value): string` (RFC 5952); `formatPrefix(p): string` (bare address for host prefixes, else CIDR — the canonical query form); `formatCidr(p): string` (always `/len`); `prefixContains(outer, inner): boolean`; `rangeToCidrs(family, start: bigint, end: bigint): IpPrefix[]`; `bitsOf(family): number`.

- [ ] **Step 1: Create the workspace files**

`package.json`:
```json
{
  "name": "rir-mcp",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.8.1",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:live": "RIR_MCP_LIVE=1 vitest run packages/core/test/live",
    "typecheck": "tsc -p tsconfig.json",
    "fixtures:record": "tsx scripts/fixtures-record.ts"
  },
  "devDependencies": {
    "@types/node": "^26.6.3",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2",
    "vitest": "^5.0.2"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["packages/*/src", "packages/*/test", "scripts", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
```

`.gitignore`:
```
node_modules/
coverage/
.env
.env.*
.dev.vars
*.local
```

`packages/core/package.json`:
```json
{
  "name": "@ieisi/rir-mcp-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.2.0",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.2.0"
  }
}
```

- [ ] **Step 2: Install**

Run: `corepack enable pnpm && pnpm install` (if corepack cannot write its shim, use `npm install -g pnpm@12.8.1 && pnpm install`).
Then: `pnpm exec tsc --version` — Expected: `Version 7.x`. If it is not 7.x, stop and report.

- [ ] **Step 3: Write the failing test**

`packages/core/test/input/ip.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { InputError } from '../../src/input/errors';
import { formatCidr, formatPrefix, parseIpOrCidr, prefixContains, rangeToCidrs } from '../../src/input/ip';

describe('parseIpOrCidr + formatPrefix', () => {
  it.each([
    ['1.1.1.1', '1.1.1.1'],
    [' 1.1.1.1 ', '1.1.1.1'],
    ['1.1.1.1/24', '1.1.1.0/24'],
    ['1.1.1.1/32', '1.1.1.1'],
    ['0.0.0.0/0', '0.0.0.0/0'],
    ['2001:DB8::1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['2001:db8::/32', '2001:db8::/32'],
    ['2001:db8:1234::/32', '2001:db8::/32'],
    ['::', '::'],
    ['::1', '::1'],
    ['::ffff:1.2.3.4', '::ffff:102:304'],
  ])('canonicalises %j -> %s', (input, expected) => {
    expect(formatPrefix(parseIpOrCidr(input))).toBe(expected);
  });

  it.each([
    '', '1.1.1', '1.1.1.1.1', '256.1.1.1', '010.1.1.1', '1.1.1.1/33', '1.1.1.1/', '1.1.1.1/24/1',
    '2001:db8:::1', '2001:db8::1::2', '12345::', 'fe80::1%eth0', 'example.com', '1.2.3.4::', 'gggg::1',
  ])('rejects %j with an InputError carrying an example', (input) => {
    expect(() => parseIpOrCidr(input)).toThrow(InputError);
    try { parseIpOrCidr(input); } catch (e) { expect((e as InputError).hint).toContain('1.1.1.1'); }
  });
});

describe('formatCidr', () => {
  it('always includes the length', () => {
    expect(formatCidr(parseIpOrCidr('1.1.1.1'))).toBe('1.1.1.1/32');
    expect(formatCidr(parseIpOrCidr('2001:db8::/32'))).toBe('2001:db8::/32');
  });
});

describe('prefixContains', () => {
  it('checks family, length and network bits', () => {
    const net = parseIpOrCidr('1.1.1.0/24');
    expect(prefixContains(net, parseIpOrCidr('1.1.1.200'))).toBe(true);
    expect(prefixContains(net, parseIpOrCidr('1.1.2.1'))).toBe(false);
    expect(prefixContains(net, parseIpOrCidr('1.1.0.0/16'))).toBe(false);
    expect(prefixContains(parseIpOrCidr('::/0'), parseIpOrCidr('1.1.1.1'))).toBe(false);
  });
});

describe('rangeToCidrs', () => {
  it('returns the minimal CIDR cover', () => {
    const a = parseIpOrCidr('1.1.1.0'), b = parseIpOrCidr('1.1.1.255'), c = parseIpOrCidr('1.1.2.127');
    expect(rangeToCidrs(4, a.value, b.value).map(formatCidr)).toEqual(['1.1.1.0/24']);
    expect(rangeToCidrs(4, a.value, c.value).map(formatCidr)).toEqual(['1.1.1.0/24', '1.1.2.0/25']);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/input/ip.test.ts`
Expected: FAIL — cannot resolve `../../src/input/errors`.

- [ ] **Step 5: Write the implementation**

`packages/core/src/input/errors.ts`:
```ts
/** A user-supplied value could not be parsed. `hint` shows an accepted form. */
export class InputError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'InputError';
    this.hint = hint;
  }
}
```

`packages/core/src/input/ip.ts`:
```ts
import { InputError } from './errors';

export type IpFamily = 4 | 6;

/** A network prefix with host bits zeroed; `value` is the address as an unsigned integer. */
export interface IpPrefix {
  readonly family: IpFamily;
  readonly value: bigint;
  readonly length: number;
}

const BITS: Readonly<Record<IpFamily, number>> = { 4: 32, 6: 128 };
const IP_HINT = 'Use one IPv4/IPv6 address or CIDR, e.g. 1.1.1.1, 1.1.1.0/24 or 2001:db8::/32.';

export function bitsOf(family: IpFamily): number {
  return BITS[family];
}

function mask(family: IpFamily, length: number): bigint {
  const bits = BITS[family];
  if (length === 0) return 0n;
  const all = (1n << BigInt(bits)) - 1n;
  const host = BigInt(bits - length);
  return (all >> host) << host;
}

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    // No leading zeros: "010" is ambiguous (octal in some parsers).
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function v6Groups(part: string): number[] | null {
  if (part === '') return [];
  const out: number[] = [];
  const items = part.split(':');
  for (let i = 0; i < items.length; i++) {
    const item = items[i] ?? '';
    if (item.includes('.')) {
      if (i !== items.length - 1) return null;
      const v4 = parseV4(item);
      if (v4 === null) return null;
      out.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(item)) return null;
      out.push(parseInt(item, 16));
    }
  }
  return out;
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  if (halves.length === 2 && (halves[0] ?? '').includes('.')) return null;
  const head = v6Groups(halves[0] ?? '');
  const tail = halves.length === 2 ? v6Groups(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}

export function parseIpOrCidr(raw: string): IpPrefix {
  const s = raw.trim();
  if (s.includes('%')) throw new InputError(`Zone IDs are not supported: ${s}`, IP_HINT);
  const [addr, len, ...rest] = s.split('/');
  if (!addr || rest.length > 0) throw new InputError(`Not an IP address or CIDR: "${s}"`, IP_HINT);
  const family: IpFamily = addr.includes(':') ? 6 : 4;
  const value = family === 4 ? parseV4(addr) : parseV6(addr);
  if (value === null) throw new InputError(`Not a valid IPv${family} address: "${addr}"`, IP_HINT);
  const bits = BITS[family];
  let length = bits;
  if (len !== undefined) {
    if (!/^\d{1,3}$/.test(len) || Number(len) > bits) {
      throw new InputError(`Invalid prefix length "/${len}" for IPv${family}`, IP_HINT);
    }
    length = Number(len);
  }
  return { family, value: value & mask(family, length), length };
}

export function formatAddress(family: IpFamily, value: bigint): string {
  if (family === 4) return [24n, 16n, 8n, 0n].map((sh) => String((value >> sh) & 0xffn)).join('.');
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  // RFC 5952: compress the longest run (length >= 2) of zero groups; leftmost wins ties.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i >= 2 && j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/** Canonical query form: bare address for host prefixes, CIDR otherwise. */
export function formatPrefix(p: IpPrefix): string {
  const addr = formatAddress(p.family, p.value);
  return p.length === BITS[p.family] ? addr : `${addr}/${p.length}`;
}

export function formatCidr(p: IpPrefix): string {
  return `${formatAddress(p.family, p.value)}/${p.length}`;
}

export function prefixContains(outer: IpPrefix, inner: IpPrefix): boolean {
  return (
    outer.family === inner.family &&
    outer.length <= inner.length &&
    (inner.value & mask(outer.family, outer.length)) === outer.value
  );
}

/** Minimal list of CIDR blocks covering [start, end] inclusive. */
export function rangeToCidrs(family: IpFamily, start: bigint, end: bigint): IpPrefix[] {
  const bits = BITS[family];
  const out: IpPrefix[] = [];
  let cur = start;
  while (cur <= end) {
    let size = 0;
    while (size < bits) {
      const blockMask = (1n << BigInt(size + 1)) - 1n;
      if ((cur & blockMask) !== 0n || cur + blockMask > end) break;
      size += 1;
    }
    out.push({ family, value: cur, length: bits - size });
    cur += 1n << BigInt(size);
  }
  return out;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm vitest run packages/core/test/input/ip.test.ts && pnpm typecheck`
Expected: all tests PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts .gitignore packages/core
git commit -m "feat(core): scaffold workspace and add IP/CIDR parsing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: ASN, handle, RIR identity and reverse zones

**Files:**
- Create: `packages/core/src/rdap/rirs.ts`, `packages/core/src/input/asn.ts`, `packages/core/src/input/handle.ts`, `packages/core/src/input/reverse-zone.ts`
- Test: `packages/core/test/input/asn-handle.test.ts`, `packages/core/test/input/reverse-zone.test.ts`

**Interfaces:**
- Consumes: `InputError`, `IpPrefix`, `parseIpOrCidr` (Task 1).
- Produces: `RIRS`, `type Rir = 'apnic' | 'arin' | 'ripe' | 'lacnic' | 'afrinic'`, `RIR_LABEL: Record<Rir, string>`, `RIR_HOSTS: Readonly<Record<string, Rir>>`; `parseAsn(raw: string | number): number`; `parseHandle(raw: string): string`; `inferRirFromHandle(handle: string): Rir | null`; `reverseZones(p: IpPrefix): string[]` (most specific first; v4 up to 3 zones, v6 candidates at nibble counts `min(len/4,16)`, 12, 8).

- [ ] **Step 1: Write the failing tests**

`packages/core/test/input/asn-handle.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseAsn } from '../../src/input/asn';
import { InputError } from '../../src/input/errors';
import { inferRirFromHandle, parseHandle } from '../../src/input/handle';

describe('parseAsn', () => {
  it.each<[string | number, number]>([
    ['AS4608', 4608], ['as4608', 4608], [' AS 4608 ', 4608], ['AS04608', 4608], ['4608', 4608],
    [4608, 4608], ['1.10', 65546], ['4294967295', 4294967295], [0, 0],
  ])('parses %j -> %d', (input, expected) => {
    expect(parseAsn(input)).toBe(expected);
  });

  it.each<string | number>(['', 'AS', 'ASX1', '4294967296', '1.65536', -1, 1.5, 'AS-FOO'])('rejects %j', (input) => {
    expect(() => parseAsn(input)).toThrow(InputError);
    try { parseAsn(input); } catch (e) { expect((e as InputError).hint).toContain('AS4608'); }
  });
});

describe('parseHandle', () => {
  it('trims and upper-cases', () => {
    expect(parseHandle(' org-arad1-ap ')).toBe('ORG-ARAD1-AP');
  });
  it.each(['', '-LEADING', 'HAS SPACE', 'A/B', 'X'.repeat(65), 'ORG_UNDERSCORE'])('rejects %j', (input) => {
    expect(() => parseHandle(input)).toThrow(InputError);
  });
});

describe('inferRirFromHandle', () => {
  it.each([
    ['ORG-ARAD1-AP', 'apnic'], ['GOGL-ARIN', 'arin'], ['ORG-RIEN1-RIPE', 'ripe'],
    ['ORG-AFNC1-AFRINIC', 'afrinic'], ['XX-LACNIC', 'lacnic'], ['IRT-APNICRANDNET-AU', null],
  ])('%s -> %s', (handle, rir) => {
    expect(inferRirFromHandle(handle)).toBe(rir);
  });
});
```

`packages/core/test/input/reverse-zone.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseIpOrCidr } from '../../src/input/ip';
import { reverseZones } from '../../src/input/reverse-zone';

describe('reverseZones', () => {
  it.each([
    ['1.1.1.1', ['1.1.1.in-addr.arpa', '1.1.in-addr.arpa', '1.in-addr.arpa']],
    ['203.0.113.5', ['113.0.203.in-addr.arpa', '0.203.in-addr.arpa', '203.in-addr.arpa']],
    ['10.0.0.0/8', ['10.in-addr.arpa']],
    ['10.0.0.0/12', ['10.in-addr.arpa']],
    ['0.0.0.0/0', []],
    ['2001:db8::/32', ['8.b.d.0.1.0.0.2.ip6.arpa']],
    ['2001:dc0::1', [
      '0.0.0.0.0.0.0.0.0.c.d.0.1.0.0.2.ip6.arpa',
      '0.0.0.0.0.c.d.0.1.0.0.2.ip6.arpa',
      '0.c.d.0.1.0.0.2.ip6.arpa',
    ]],
    ['2400::/12', ['0.4.2.ip6.arpa']],
  ])('%s -> %j', (input, zones) => {
    expect(reverseZones(parseIpOrCidr(input))).toEqual(zones);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/input`
Expected: FAIL — cannot resolve `../../src/input/asn`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/rdap/rirs.ts`:
```ts
export const RIRS = ['apnic', 'arin', 'ripe', 'lacnic', 'afrinic'] as const;
export type Rir = (typeof RIRS)[number];

export const RIR_LABEL: Readonly<Record<Rir, string>> = {
  apnic: 'APNIC',
  arin: 'ARIN',
  ripe: 'RIPE NCC',
  lacnic: 'LACNIC',
  afrinic: 'AFRINIC',
};

/** RDAP hostnames as listed in the IANA bootstrap files. */
export const RIR_HOSTS: Readonly<Record<string, Rir>> = {
  'rdap.apnic.net': 'apnic',
  'rdap.arin.net': 'arin',
  'rdap.db.ripe.net': 'ripe',
  'rdap.lacnic.net': 'lacnic',
  'rdap.afrinic.net': 'afrinic',
};
```

`packages/core/src/input/asn.ts`:
```ts
import { InputError } from './errors';

export const ASN_MAX = 4294967295;
const ASN_HINT = 'Use an AS number such as AS4608 or 4608 (asdot like 1.10 is also accepted).';

export function parseAsn(raw: string | number): number {
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw >= 0 && raw <= ASN_MAX) return raw;
    throw new InputError(`AS number out of range: ${raw}`, ASN_HINT);
  }
  const s = raw.trim().replace(/^AS\s*/i, '');
  let n: number;
  const asdot = /^(\d{1,5})\.(\d{1,5})$/.exec(s);
  if (asdot) {
    const hi = Number(asdot[1]);
    const lo = Number(asdot[2]);
    if (hi > 65535 || lo > 65535) throw new InputError(`Invalid asdot AS number: "${raw}"`, ASN_HINT);
    n = hi * 65536 + lo;
  } else if (/^\d{1,10}$/.test(s)) {
    n = Number(s);
  } else {
    throw new InputError(`Not an AS number: "${raw}"`, ASN_HINT);
  }
  if (n > ASN_MAX) throw new InputError(`AS number out of range: "${raw}"`, ASN_HINT);
  return n;
}
```

`packages/core/src/input/handle.ts`:
```ts
import type { Rir } from '../rdap/rirs';
import { InputError } from './errors';

const HANDLE_RE = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const HANDLE_HINT = 'Use a registry handle such as ORG-ARAD1-AP or IRT-APNICRANDNET-AU.';

export function parseHandle(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (!HANDLE_RE.test(s)) throw new InputError(`Not a registry handle: "${raw}"`, HANDLE_HINT);
  return s;
}

const SUFFIXES: ReadonlyArray<readonly [string, Rir]> = [
  ['-AFRINIC', 'afrinic'],
  ['-LACNIC', 'lacnic'],
  ['-ARIN', 'arin'],
  ['-RIPE', 'ripe'],
  ['-AP', 'apnic'],
];

/** Guess the RIR from a handle suffix; null when the suffix is not RIR-specific. */
export function inferRirFromHandle(handle: string): Rir | null {
  for (const [suffix, rir] of SUFFIXES) if (handle.endsWith(suffix)) return rir;
  return null;
}
```

`packages/core/src/input/reverse-zone.ts`:
```ts
import type { IpPrefix } from './ip';

/**
 * Candidate reverse-DNS zones for a prefix, most specific first.
 * IPv4: octet zones (/24, /16, /8). IPv6: nibble zones at the prefix's own
 * nibble boundary (capped at /64), then /48 and /32 — where RIR delegations usually sit.
 */
export function reverseZones(p: IpPrefix): string[] {
  if (p.family === 4) {
    const zones: string[] = [];
    for (let octets = Math.min(Math.floor(p.length / 8), 3); octets >= 1; octets--) {
      const labels: string[] = [];
      for (let i = 0; i < octets; i++) labels.push(String((p.value >> BigInt(24 - 8 * i)) & 0xffn));
      zones.push(`${labels.reverse().join('.')}.in-addr.arpa`);
    }
    return zones;
  }
  const start = Math.min(Math.floor(p.length / 4), 16);
  const counts = [...new Set([start, 12, 8])].filter((n) => n >= 1 && n <= start).sort((a, b) => b - a);
  return counts.map((nibbles) => {
    const labels: string[] = [];
    for (let i = 0; i < nibbles; i++) labels.push(((p.value >> BigInt(124 - 4 * i)) & 0xfn).toString(16));
    return `${labels.reverse().join('.')}.ip6.arpa`;
  });
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/core/test/input && pnpm typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): parse ASNs and handles, derive reverse-DNS zones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Special-purpose address and ASN answers

**Files:**
- Create: `packages/core/src/special-use.ts`
- Test: `packages/core/test/special-use.test.ts`

**Interfaces:**
- Consumes: `IpPrefix`, `parseIpOrCidr`, `prefixContains` (Task 1).
- Produces: `interface SpecialUse { name: string; ref: string }`; `specialUseForIp(p: IpPrefix): SpecialUse | null` (most specific containing block); `specialUseForAsn(n: number): SpecialUse | null`.

Table values were checked against the IANA registries on 2026-09-30 (`[IANA-SP4]`, `[IANA-SP6]`, `[IANA-SPASN]` in `docs/BIBLIOGRAPHY.md`). Do not add rows without checking the registry.

- [ ] **Step 1: Write the failing test**

`packages/core/test/special-use.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseIpOrCidr } from '../src/input/ip';
import { specialUseForAsn, specialUseForIp } from '../src/special-use';

describe('specialUseForIp', () => {
  it.each([
    ['10.1.2.3', 'Private-Use', 'RFC 1918'],
    ['192.168.0.0/24', 'Private-Use', 'RFC 1918'],
    ['100.64.1.1', 'Shared Address Space', 'RFC 6598'],
    ['203.0.113.5', 'Documentation (TEST-NET-3)', 'RFC 5737'],
    ['192.88.99.1', 'Deprecated (6to4 Relay Anycast)', 'RFC 7526'],
    ['255.255.255.255', 'Limited Broadcast', 'RFC 919'],
    ['2001:db8::1', 'Documentation', 'RFC 3849'],
    ['3fff::1', 'Documentation', 'RFC 9637'],
    ['fe80::1', 'Link-Local Unicast', 'RFC 4291'],
    ['::1', 'Loopback Address', 'RFC 4291'],
  ])('%s is %s (%s)', (input, name, ref) => {
    expect(specialUseForIp(parseIpOrCidr(input))).toEqual({ name, ref });
  });

  it.each(['1.1.1.1', '8.8.8.0/24', '2001:dc0::1', '10.0.0.0/7'])('%s is not special', (input) => {
    expect(specialUseForIp(parseIpOrCidr(input))).toBeNull();
  });
});

describe('specialUseForAsn', () => {
  it.each([
    [0, 'Reserved'], [23456, 'AS_TRANS'], [64500, 'Documentation'], [64512, 'Private use'],
    [65535, 'Reserved'], [65540, 'Documentation'], [4200000000, 'Private use'], [4294967295, 'Reserved'],
  ])('AS%d is %s', (asn, name) => {
    expect(specialUseForAsn(asn)?.name).toBe(name);
  });

  it.each([4608, 15169, 131072])('AS%d is not special', (asn) => {
    expect(specialUseForAsn(asn)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/special-use.test.ts`
Expected: FAIL — cannot resolve `../src/special-use`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/special-use.ts`:
```ts
import { parseIpOrCidr, prefixContains, type IpPrefix } from './input/ip';

export interface SpecialUse {
  readonly name: string;
  readonly ref: string;
}

// IANA IPv4/IPv6 Special-Purpose Address Registries (checked 2026-09-30).
const IP_TABLE: ReadonlyArray<readonly [string, string, string]> = [
  ['0.0.0.0/8', '"This network"', 'RFC 791'],
  ['10.0.0.0/8', 'Private-Use', 'RFC 1918'],
  ['100.64.0.0/10', 'Shared Address Space', 'RFC 6598'],
  ['127.0.0.0/8', 'Loopback', 'RFC 1122'],
  ['169.254.0.0/16', 'Link Local', 'RFC 3927'],
  ['172.16.0.0/12', 'Private-Use', 'RFC 1918'],
  ['192.0.0.0/24', 'IETF Protocol Assignments', 'RFC 6890'],
  ['192.0.2.0/24', 'Documentation (TEST-NET-1)', 'RFC 5737'],
  ['192.88.99.0/24', 'Deprecated (6to4 Relay Anycast)', 'RFC 7526'],
  ['192.168.0.0/16', 'Private-Use', 'RFC 1918'],
  ['198.18.0.0/15', 'Benchmarking', 'RFC 2544'],
  ['198.51.100.0/24', 'Documentation (TEST-NET-2)', 'RFC 5737'],
  ['203.0.113.0/24', 'Documentation (TEST-NET-3)', 'RFC 5737'],
  ['240.0.0.0/4', 'Reserved', 'RFC 1112'],
  ['255.255.255.255/32', 'Limited Broadcast', 'RFC 919'],
  ['::/128', 'Unspecified Address', 'RFC 4291'],
  ['::1/128', 'Loopback Address', 'RFC 4291'],
  ['::ffff:0:0/96', 'IPv4-mapped Address', 'RFC 4291'],
  ['64:ff9b::/96', 'IPv4-IPv6 Translation', 'RFC 6052'],
  ['64:ff9b:1::/48', 'IPv4-IPv6 Translation', 'RFC 8215'],
  ['100::/64', 'Discard-Only Address Block', 'RFC 6666'],
  ['2001::/23', 'IETF Protocol Assignments', 'RFC 2928'],
  ['2001:db8::/32', 'Documentation', 'RFC 3849'],
  ['2002::/16', '6to4', 'RFC 3056'],
  ['3fff::/20', 'Documentation', 'RFC 9637'],
  ['fc00::/7', 'Unique-Local', 'RFC 4193'],
  ['fe80::/10', 'Link-Local Unicast', 'RFC 4291'],
];

// IANA Special-Purpose AS Numbers Registry (checked 2026-09-30).
const ASN_TABLE: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, 0, 'Reserved', 'RFC 7607'],
  [23456, 23456, 'AS_TRANS', 'RFC 6793'],
  [64496, 64511, 'Documentation', 'RFC 5398'],
  [64512, 65534, 'Private use', 'RFC 6996'],
  [65535, 65535, 'Reserved', 'RFC 7300'],
  [65536, 65551, 'Documentation', 'RFC 5398'],
  [4200000000, 4294967294, 'Private use', 'RFC 6996'],
  [4294967295, 4294967295, 'Reserved', 'RFC 7300'],
];

const IP_BLOCKS = IP_TABLE.map(([cidr, name, ref]) => ({ prefix: parseIpOrCidr(cidr), use: { name, ref } }));

export function specialUseForIp(p: IpPrefix): SpecialUse | null {
  let best: (typeof IP_BLOCKS)[number] | null = null;
  for (const block of IP_BLOCKS) {
    if (prefixContains(block.prefix, p) && (!best || block.prefix.length > best.prefix.length)) best = block;
  }
  return best ? best.use : null;
}

export function specialUseForAsn(n: number): SpecialUse | null {
  const row = ASN_TABLE.find(([start, end]) => n >= start && n <= end);
  return row ? { name: row[2], ref: row[3] } : null;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/core/test/special-use.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): answer IANA special-purpose addresses and ASNs locally

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Ports, per-RIR limits, in-memory cache and rate limiter

**Files:**
- Create: `packages/core/src/ports.ts`, `packages/core/src/rdap/limits.ts`, `packages/core/src/memory/cache.ts`, `packages/core/src/memory/rate-limiter.ts`, `packages/core/test/support/fake-clock.ts`
- Test: `packages/core/test/memory/cache.test.ts`, `packages/core/test/memory/rate-limiter.test.ts`

**Interfaces:**
- Consumes: `Rir` (Task 2).
- Produces:
  - `type FetchLike = (url: string, init?: RequestInit) => Promise<Response>`
  - `interface Clock { now(): number }` (ms), `systemClock: Clock`
  - `interface CacheEntry<T> { value: T; fetchedAt: number; freshUntil: number; staleUntil: number }` (ms timestamps)
  - `interface CacheStore { get<T>(key): Promise<CacheEntry<T> | null>; put<T>(key, entry: CacheEntry<T>): Promise<void> }` — `get` returns null once `now >= staleUntil`.
  - `type AcquireResult = { ok: true } | { ok: false; retryAfterS: number }`
  - `interface RateLimiter { acquire(bucket: string, weight: number): Promise<AcquireResult>; penalise(bucket: string): Promise<void> }`
  - `interface LimitProfile { ratePerS: number; burst: number; hourlyCap?: number }`, `DEFAULT_LIMITS: Record<Rir, LimitProfile>`, `PENALTY_FACTOR = 0.5`, `PENALTY_MS = 300_000`, `clampProfile(requested: Partial<LimitProfile>, max: LimitProfile): LimitProfile`
  - `class MemoryCache implements CacheStore` — `new MemoryCache(clock, maxEntries = 10_000)`
  - `class MemoryRateLimiter implements RateLimiter` — `new MemoryRateLimiter(profiles: Readonly<Record<string, LimitProfile>>, clock)`
  - test helper `class FakeClock implements Clock { t: number; now(); advance(ms) }`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/support/fake-clock.ts`:
```ts
import type { Clock } from '../../src/ports';

export class FakeClock implements Clock {
  t = Date.UTC(2026, 8, 30);

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}
```

`packages/core/test/memory/cache.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../src/memory/cache';
import { FakeClock } from '../support/fake-clock';

const entry = (clock: FakeClock, value: string) => ({
  value, fetchedAt: clock.now(), freshUntil: clock.now() + 1_000, staleUntil: clock.now() + 5_000,
});

describe('MemoryCache', () => {
  it('returns stored entries until staleUntil, then forgets them', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCache(clock);
    await cache.put('k', entry(clock, 'v'));
    expect((await cache.get<string>('k'))?.value).toBe('v');
    clock.advance(4_999);
    expect((await cache.get<string>('k'))?.value).toBe('v');
    clock.advance(1);
    expect(await cache.get('k')).toBeNull();
  });

  it('evicts the least recently used entry beyond maxEntries', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCache(clock, 2);
    await cache.put('a', entry(clock, 'A'));
    await cache.put('b', entry(clock, 'B'));
    await cache.get('a');
    await cache.put('c', entry(clock, 'C'));
    expect(await cache.get('b')).toBeNull();
    expect((await cache.get<string>('a'))?.value).toBe('A');
    expect((await cache.get<string>('c'))?.value).toBe('C');
  });
});
```

`packages/core/test/memory/rate-limiter.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../../src/memory/rate-limiter';
import { clampProfile, DEFAULT_LIMITS } from '../../src/rdap/limits';
import { FakeClock } from '../support/fake-clock';

describe('MemoryRateLimiter', () => {
  it('allows the burst, then refills at the sustained rate', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, clock);
    for (let i = 0; i < 5; i++) expect(await lim.acquire('apnic', 1)).toEqual({ ok: true });
    expect(await lim.acquire('apnic', 1)).toEqual({ ok: false, retryAfterS: 1 });
    clock.advance(1_000);
    expect(await lim.acquire('apnic', 1)).toEqual({ ok: true });
  });

  it('charges history lookups weight 5', async () => {
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, new FakeClock());
    expect(await lim.acquire('apnic', 5)).toEqual({ ok: true });
    expect(await lim.acquire('apnic', 1)).toMatchObject({ ok: false });
  });

  it('keeps RIR buckets independent', async () => {
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, new FakeClock());
    await lim.acquire('ripe', 5);
    expect(await lim.acquire('apnic', 1)).toEqual({ ok: true });
  });

  it('applies the LACNIC profile: burst 3, then one request per 6 s', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, clock);
    for (let i = 0; i < 3; i++) expect(await lim.acquire('lacnic', 1)).toEqual({ ok: true });
    expect(await lim.acquire('lacnic', 1)).toEqual({ ok: false, retryAfterS: 6 });
    clock.advance(6_000);
    expect(await lim.acquire('lacnic', 1)).toEqual({ ok: true });
  });

  it('enforces an hourly cap', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter({ x: { ratePerS: 1000, burst: 1000, hourlyCap: 3 } }, clock);
    for (let i = 0; i < 3; i++) expect(await lim.acquire('x', 1)).toEqual({ ok: true });
    expect(await lim.acquire('x', 1)).toEqual({ ok: false, retryAfterS: 3600 });
    clock.advance(3_600_000);
    expect(await lim.acquire('x', 1)).toEqual({ ok: true });
  });

  it('penalise empties the bucket and halves the refill rate for 5 minutes', async () => {
    const clock = new FakeClock();
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, clock);
    await lim.penalise('apnic');
    clock.advance(1_000);
    expect(await lim.acquire('apnic', 1)).toMatchObject({ ok: false });
    clock.advance(1_000);
    expect(await lim.acquire('apnic', 1)).toEqual({ ok: true });
  });

  it('throws for an unknown bucket', async () => {
    const lim = new MemoryRateLimiter(DEFAULT_LIMITS, new FakeClock());
    await expect(lim.acquire('nope', 1)).rejects.toThrow('No rate-limit profile');
  });
});

describe('clampProfile', () => {
  it('lets operators lower limits but never raise them', () => {
    expect(clampProfile({ ratePerS: 5, burst: 2 }, DEFAULT_LIMITS.apnic)).toEqual({ ratePerS: 1, burst: 2 });
    expect(clampProfile({ hourlyCap: 5000 }, DEFAULT_LIMITS.lacnic)).toEqual({ ratePerS: 10 / 60, burst: 3, hourlyCap: 1000 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/memory`
Expected: FAIL — cannot resolve `../../src/memory/cache`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/ports.ts`:
```ts
/** Runtime-provided capabilities. Core code depends only on these interfaces. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface CacheEntry<T> {
  readonly value: T;
  readonly fetchedAt: number;
  readonly freshUntil: number;
  readonly staleUntil: number;
}

export interface CacheStore {
  /** Returns null when absent or when now >= staleUntil. */
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  put<T>(key: string, entry: CacheEntry<T>): Promise<void>;
}

export type AcquireResult = { readonly ok: true } | { readonly ok: false; readonly retryAfterS: number };

export interface RateLimiter {
  acquire(bucket: string, weight: number): Promise<AcquireResult>;
  /** Called after upstream 429/5xx/timeout/bad response: back off this bucket. */
  penalise(bucket: string): Promise<void>;
}
```

`packages/core/src/rdap/limits.ts`:
```ts
import type { Rir } from './rirs';

export interface LimitProfile {
  readonly ratePerS: number;
  readonly burst: number;
  readonly hourlyCap?: number;
}

/** Defaults are also the maximum an operator may configure (spec §6). */
export const DEFAULT_LIMITS: Readonly<Record<Rir, LimitProfile>> = {
  apnic: { ratePerS: 1, burst: 5 },
  arin: { ratePerS: 1, burst: 5 },
  ripe: { ratePerS: 1, burst: 5 },
  afrinic: { ratePerS: 1, burst: 5 },
  // LACNIC publishes 10/min and 1,000/hour per IP [LACNIC-RDAP].
  lacnic: { ratePerS: 10 / 60, burst: 3, hourlyCap: 1000 },
};

export const PENALTY_FACTOR = 0.5;
export const PENALTY_MS = 5 * 60_000;

export function clampProfile(requested: Partial<LimitProfile>, max: LimitProfile): LimitProfile {
  const profile: { ratePerS: number; burst: number; hourlyCap?: number } = {
    ratePerS: Math.min(requested.ratePerS ?? max.ratePerS, max.ratePerS),
    burst: Math.min(requested.burst ?? max.burst, max.burst),
  };
  const cap = requested.hourlyCap ?? max.hourlyCap;
  if (cap !== undefined) profile.hourlyCap = max.hourlyCap !== undefined ? Math.min(cap, max.hourlyCap) : cap;
  return profile;
}
```

`packages/core/src/memory/cache.ts`:
```ts
import type { CacheEntry, CacheStore, Clock } from '../ports';

/** LRU cache in process memory. Map insertion order doubles as recency order. */
export class MemoryCache implements CacheStore {
  private readonly map = new Map<string, CacheEntry<unknown>>();
  private readonly clock: Clock;
  private readonly maxEntries: number;

  constructor(clock: Clock, maxEntries = 10_000) {
    this.clock = clock;
    this.maxEntries = maxEntries;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const entry = this.map.get(key);
    if (!entry) return null;
    this.map.delete(key);
    if (this.clock.now() >= entry.staleUntil) return null;
    this.map.set(key, entry);
    return entry as CacheEntry<T>;
  }

  async put<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
```

`packages/core/src/memory/rate-limiter.ts`:
```ts
import type { AcquireResult, Clock, RateLimiter } from '../ports';
import { PENALTY_FACTOR, PENALTY_MS, type LimitProfile } from '../rdap/limits';

interface BucketState {
  tokens: number;
  updatedAt: number;
  penaltyUntil: number;
  windowStart: number;
  windowCount: number;
}

const HOUR_MS = 3_600_000;
const EPSILON = 1e-9; // absorbs float error, e.g. 6 s x (10/60) = 0.9999999999999999

/** Token bucket per named bucket, with an optional fixed-window hourly cap. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly state = new Map<string, BucketState>();
  private readonly profiles: Readonly<Record<string, LimitProfile>>;
  private readonly clock: Clock;

  constructor(profiles: Readonly<Record<string, LimitProfile>>, clock: Clock) {
    this.profiles = profiles;
    this.clock = clock;
  }

  async acquire(name: string, weight: number): Promise<AcquireResult> {
    const profile = this.profile(name);
    const now = this.clock.now();
    const s = this.refill(name, profile, now);
    if (profile.hourlyCap !== undefined && s.windowCount + weight > profile.hourlyCap) {
      return { ok: false, retryAfterS: Math.ceil((s.windowStart + HOUR_MS - now) / 1000) };
    }
    const cost = Math.min(weight, profile.burst);
    if (s.tokens + EPSILON < cost) {
      const rate = this.rate(profile, s, now);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((cost - s.tokens) / rate - EPSILON)) };
    }
    s.tokens = Math.max(0, s.tokens - cost);
    s.windowCount += weight;
    return { ok: true };
  }

  async penalise(name: string): Promise<void> {
    const profile = this.profiles[name];
    if (!profile) return;
    const now = this.clock.now();
    const s = this.refill(name, profile, now);
    s.tokens = 0;
    s.penaltyUntil = now + PENALTY_MS;
  }

  private profile(name: string): LimitProfile {
    const profile = this.profiles[name];
    if (!profile) throw new Error(`No rate-limit profile for bucket "${name}"`);
    return profile;
  }

  private rate(profile: LimitProfile, s: BucketState, now: number): number {
    return profile.ratePerS * (now < s.penaltyUntil ? PENALTY_FACTOR : 1);
  }

  private refill(name: string, profile: LimitProfile, now: number): BucketState {
    let s = this.state.get(name);
    if (!s) {
      s = { tokens: profile.burst, updatedAt: now, penaltyUntil: 0, windowStart: now, windowCount: 0 };
      this.state.set(name, s);
    }
    s.tokens = Math.min(profile.burst, s.tokens + ((now - s.updatedAt) / 1000) * this.rate(profile, s, now));
    s.updatedAt = now;
    if (now - s.windowStart >= HOUR_MS) {
      s.windowStart = now;
      s.windowCount = 0;
    }
    return s;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/core/test/memory && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add cache/limiter ports, per-RIR limits and in-memory backends

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: RDAP HTTP client and User-Agent

**Files:**
- Create: `packages/core/src/version.ts`, `packages/core/src/rdap/errors.ts`, `packages/core/src/rdap/client.ts`, `packages/core/src/rdap/user-agent.ts`, `packages/core/test/support/fake-fetch.ts`
- Test: `packages/core/test/rdap/client.test.ts`

**Interfaces:**
- Consumes: `FetchLike` (Task 4).
- Produces:
  - `VERSION = '0.1.0'`
  - `type RdapErrorCode = 'not_found' | 'rate_limited' | 'upstream' | 'timeout' | 'too_large' | 'bad_response' | 'redirect_blocked'`; `class RdapError extends Error { code; status?: number; retryAfterS?: number }`
  - `interface HttpDeps { fetch: FetchLike; userAgent: string; timeoutMs?: number }`; `MAX_BYTES = { current: 2_000_000, history: 5_000_000 }`
  - `fetchJson(url: string, opts: { maxBytes: number; allowRedirectTo?: (host: string) => boolean }, deps: HttpDeps): Promise<unknown>`
  - `REPO_URL`, `buildUserAgent(operator: string): string` (throws `Error` for empty, multi-line, parenthesised or > 200-char contacts)
  - test helper `fakeFetch(routes)` returning a `FetchLike` with `.calls: string[]` and `.inits: RequestInit[]`

- [ ] **Step 1: Write the test helper and the failing test**

`packages/core/test/support/fake-fetch.ts`:
```ts
import type { FetchLike } from '../../src/ports';

export interface FakeRoute {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
}

export type FakeFetch = FetchLike & { calls: string[]; inits: RequestInit[] };

/** Serves canned responses by exact URL; unknown URLs get 404. Always yields a tick so calls can overlap. */
export function fakeFetch(routes: Record<string, FakeRoute | (() => FakeRoute)>): FakeFetch {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push(url);
    inits.push(init ?? {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const r = routes[url];
    const route = typeof r === 'function' ? r() : r;
    if (!route) return new Response('not found', { status: 404 });
    const body = route.text ?? (route.body === undefined ? '' : JSON.stringify(route.body));
    return new Response(body, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/rdap+json', ...route.headers },
    });
  };
  return Object.assign(fn, { calls, inits });
}
```

`packages/core/test/rdap/client.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/ports';
import { fetchJson } from '../../src/rdap/client';
import { RdapError } from '../../src/rdap/errors';
import { buildUserAgent } from '../../src/rdap/user-agent';
import { fakeFetch } from '../support/fake-fetch';

const URL_A = 'https://rdap.apnic.net/ip/1.1.1.1';
const deps = (fetch: FetchLike) => ({ fetch, userAgent: 'test-agent' });
const code = async (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as RdapError).code);

describe('fetchJson', () => {
  it('returns parsed JSON and sends Accept and User-Agent', async () => {
    const f = fakeFetch({ [URL_A]: { body: { objectClassName: 'ip network' } } });
    expect(await fetchJson(URL_A, { maxBytes: 1000 }, deps(f))).toEqual({ objectClassName: 'ip network' });
    const headers = f.inits[0]?.headers as Record<string, string>;
    expect(headers['user-agent']).toBe('test-agent');
    expect(headers.accept).toContain('application/rdap+json');
  });

  it.each([
    [404, 'not_found'], [429, 'rate_limited'], [503, 'upstream'], [403, 'bad_response'],
  ])('maps HTTP %d to %s', async (status, expected) => {
    const f = fakeFetch({ [URL_A]: { status, text: 'x' } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(f)))).toBe(expected);
  });

  it('reads Retry-After on 429', async () => {
    const f = fakeFetch({ [URL_A]: { status: 429, text: '', headers: { 'retry-after': '30' } } });
    const err = await fetchJson(URL_A, { maxBytes: 1000 }, deps(f)).catch((e: unknown) => e as RdapError);
    expect(err).toBeInstanceOf(RdapError);
    expect((err as RdapError).retryAfterS).toBe(30);
  });

  it('treats a 200 HTML challenge page as bad_response', async () => {
    const f = fakeFetch({ [URL_A]: { text: '<html>checking your browser</html>', headers: { 'content-type': 'text/html' } } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(f)))).toBe('bad_response');
  });

  it('rejects oversize bodies by declared length and while streaming', async () => {
    const declared = fakeFetch({ [URL_A]: { text: '{}', headers: { 'content-length': '5000' } } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(declared)))).toBe('too_large');
    const streaming: FetchLike = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(600)); c.enqueue(new Uint8Array(600)); c.close(); },
    }));
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(streaming)))).toBe('too_large');
  });

  it('follows one redirect to an allowed https host only', async () => {
    const target = 'https://rdap.arin.net/registry/ip/8.8.8.8';
    const f = fakeFetch({
      [URL_A]: { status: 302, headers: { location: target } },
      [target]: { body: { ok: 1 } },
    });
    const allow = (h: string) => h === 'rdap.arin.net';
    expect(await fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow }, deps(f))).toEqual({ ok: 1 });

    const evil = fakeFetch({ [URL_A]: { status: 302, headers: { location: 'https://evil.example/x' } } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow }, deps(evil)))).toBe('redirect_blocked');

    const plain = fakeFetch({ [URL_A]: { status: 302, headers: { location: 'http://rdap.arin.net/x' } } });
    expect(await code(fetchJson(URL_A, { maxBytes: 1000, allowRedirectTo: allow }, deps(plain)))).toBe('redirect_blocked');
  });

  it('maps timeouts and network errors', async () => {
    const timeout: FetchLike = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(timeout)))).toBe('timeout');
    const down: FetchLike = async () => { throw new TypeError('fetch failed'); };
    expect(await code(fetchJson(URL_A, { maxBytes: 1000 }, deps(down)))).toBe('upstream');
  });
});

describe('buildUserAgent', () => {
  it('formats the product token, repo URL and operator contact', () => {
    expect(buildUserAgent(' noc@example.net ')).toBe(
      'rir-mcp/0.1.0 (+https://github.com/IEISI-ORG/rir-mcp; operator=noc@example.net)',
    );
  });
  it.each(['', '  ', 'a\nb', 'x (y)', 'x'.repeat(201)])('rejects %j', (op) => {
    expect(() => buildUserAgent(op)).toThrow('operator');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/rdap/client.test.ts`
Expected: FAIL — cannot resolve `../../src/rdap/client`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/version.ts`:
```ts
export const VERSION = '0.1.0';
```

`packages/core/src/rdap/errors.ts`:
```ts
export type RdapErrorCode =
  | 'not_found'
  | 'rate_limited'
  | 'upstream'
  | 'timeout'
  | 'too_large'
  | 'bad_response'
  | 'redirect_blocked';

export class RdapError extends Error {
  readonly code: RdapErrorCode;
  readonly status: number | undefined;
  readonly retryAfterS: number | undefined;

  constructor(code: RdapErrorCode, message: string, opts: { status?: number; retryAfterS?: number } = {}) {
    super(message);
    this.name = 'RdapError';
    this.code = code;
    this.status = opts.status;
    this.retryAfterS = opts.retryAfterS;
  }
}
```

`packages/core/src/rdap/user-agent.ts`:
```ts
import { VERSION } from '../version';

export const REPO_URL = 'https://github.com/IEISI-ORG/rir-mcp';

/** Every deployment identifies itself and its operator to the RIRs (spec §5). */
export function buildUserAgent(operator: string): string {
  const op = operator.trim();
  if (op === '' || op.length > 200 || /[\r\n()]/.test(op)) {
    throw new Error('operator must be a single-line contact (email or URL) without parentheses, at most 200 characters');
  }
  return `rir-mcp/${VERSION} (+${REPO_URL}; operator=${op})`;
}
```

`packages/core/src/rdap/client.ts`:
```ts
import type { FetchLike } from '../ports';
import { RdapError } from './errors';

export interface HttpDeps {
  readonly fetch: FetchLike;
  readonly userAgent: string;
  readonly timeoutMs?: number;
}

export const MAX_BYTES = { current: 2_000_000, history: 5_000_000 } as const;

export interface FetchJsonOptions {
  readonly maxBytes: number;
  /** Redirects are followed once, only over https, only to hosts this returns true for. */
  readonly allowRedirectTo?: (host: string) => boolean;
}

export async function fetchJson(url: string, opts: FetchJsonOptions, deps: HttpDeps): Promise<unknown> {
  let target = url;
  for (let hop = 0; hop < 2; hop++) {
    const res = await send(target, deps);
    if (res.status >= 300 && res.status < 400) {
      target = redirectTarget(res, target, hop, opts);
      continue;
    }
    if (res.status === 404) throw new RdapError('not_found', `Not found: ${target}`, { status: 404 });
    if (res.status === 429) {
      throw new RdapError('rate_limited', 'Upstream rate limit (HTTP 429)', {
        status: 429,
        retryAfterS: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    if (res.status >= 500) throw new RdapError('upstream', `Upstream error (HTTP ${res.status})`, { status: res.status });
    if (res.status !== 200) throw new RdapError('bad_response', `Unexpected HTTP ${res.status}`, { status: res.status });
    const text = await readCapped(res, opts.maxBytes);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RdapError('bad_response', `Non-JSON response from ${new URL(target).hostname}`, { status: 200 });
    }
  }
  throw new RdapError('redirect_blocked', 'Too many redirects');
}

async function send(target: string, deps: HttpDeps): Promise<Response> {
  try {
    return await deps.fetch(target, {
      redirect: 'manual',
      headers: { accept: 'application/rdap+json, application/json', 'user-agent': deps.userAgent },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  } catch (err) {
    const name = (err as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new RdapError('timeout', `Timed out fetching ${target}`);
    throw new RdapError('upstream', `Network error fetching ${target}`);
  }
}

function redirectTarget(res: Response, from: string, hop: number, opts: FetchJsonOptions): string {
  const location = res.headers.get('location');
  if (!location || hop > 0) throw new RdapError('redirect_blocked', `Unfollowable redirect from ${from}`, { status: res.status });
  const next = new URL(location, from);
  if (next.protocol !== 'https:' || !opts.allowRedirectTo?.(next.hostname)) {
    throw new RdapError('redirect_blocked', `Redirect to ${next.hostname} is not an RDAP bootstrap host`, { status: res.status });
  }
  return next.toString();
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new RdapError('too_large', `Response too large (${declared} bytes)`);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RdapError('too_large', `Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/core/test/rdap/client.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add capped, redirect-safe RDAP HTTP client and User-Agent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: IANA bootstrap router

**Files:**
- Create: `packages/core/src/rdap/bootstrap.ts`
- Test: `packages/core/test/rdap/bootstrap.test.ts`

**Interfaces:**
- Consumes: `fetchJson`, `HttpDeps`, `RdapError` (Task 5); `CacheStore`, `Clock` (Task 4); `RIR_HOSTS`, `Rir` (Task 2); `parseIpOrCidr`, `prefixContains`, `IpPrefix` (Task 1).
- Produces: `IANA_BOOTSTRAP_BASE = 'https://data.iana.org/rdap/'`; `interface Route { rir: Rir; baseUrl: string }` (baseUrl ends with `/`); `class Bootstrap` with `new Bootstrap({ http, cache, clock })`, `routeIp(p: IpPrefix): Promise<Route | null>` (longest match), `routeAsn(n: number): Promise<Route | null>`, `baseUrl(rir: Rir): Promise<string>` (throws `RdapError('upstream')` if absent), `rdapHosts(): Promise<ReadonlySet<string>>`. Throws `RdapError` when IANA is unreachable and nothing is cached.

- [ ] **Step 1: Write the failing test**

`packages/core/test/rdap/bootstrap.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseIpOrCidr } from '../../src/input/ip';
import { MemoryCache } from '../../src/memory/cache';
import { Bootstrap, IANA_BOOTSTRAP_BASE } from '../../src/rdap/bootstrap';
import { RdapError } from '../../src/rdap/errors';
import { FakeClock } from '../support/fake-clock';
import { fakeFetch, type FakeRoute } from '../support/fake-fetch';

const IANA = {
  ipv4: { services: [
    [['1.0.0.0/8'], ['https://rdap.apnic.net/']],
    [['8.0.0.0/8'], ['http://rdap.arin.net/registry/', 'https://rdap.arin.net/registry/']],
    [['41.0.0.0/8'], ['https://rdap.example.org/']],
  ] },
  ipv6: { services: [[['2001:dc0::/32'], ['https://rdap.apnic.net/']]] },
  asn: { services: [[['4608-4865'], ['https://rdap.apnic.net/']], [['15169'], ['https://rdap.arin.net/registry/']]] },
};

function setup(down = false) {
  const route = (body: unknown) => (): FakeRoute => (down ? { status: 503, text: '' } : { body });
  const fetch = fakeFetch({
    [`${IANA_BOOTSTRAP_BASE}ipv4.json`]: route(IANA.ipv4),
    [`${IANA_BOOTSTRAP_BASE}ipv6.json`]: route(IANA.ipv6),
    [`${IANA_BOOTSTRAP_BASE}asn.json`]: route(IANA.asn),
  });
  const clock = new FakeClock();
  const cache = new MemoryCache(clock);
  const boot = new Bootstrap({ http: { fetch, userAgent: 't' }, cache, clock });
  return { fetch, clock, cache, boot };
}

describe('Bootstrap', () => {
  it('routes addresses by longest match, preferring https base URLs', async () => {
    const { boot } = setup();
    expect(await boot.routeIp(parseIpOrCidr('1.1.1.1'))).toEqual({ rir: 'apnic', baseUrl: 'https://rdap.apnic.net/' });
    expect(await boot.routeIp(parseIpOrCidr('8.8.8.8'))).toEqual({ rir: 'arin', baseUrl: 'https://rdap.arin.net/registry/' });
    expect(await boot.routeIp(parseIpOrCidr('2001:dc0::1'))).toEqual({ rir: 'apnic', baseUrl: 'https://rdap.apnic.net/' });
    expect(await boot.routeIp(parseIpOrCidr('9.9.9.9'))).toBeNull();
    expect(await boot.routeIp(parseIpOrCidr('41.1.1.1'))).toBeNull(); // non-RIR host ignored
    expect(await boot.routeIp(parseIpOrCidr('0.0.0.0/0'))).toBeNull();
  });

  it('routes ASNs by range and single values', async () => {
    const { boot } = setup();
    expect((await boot.routeAsn(4608))?.rir).toBe('apnic');
    expect((await boot.routeAsn(15169))?.rir).toBe('arin');
    expect(await boot.routeAsn(1)).toBeNull();
  });

  it('exposes base URLs and RDAP hosts', async () => {
    const { boot } = setup();
    expect(await boot.baseUrl('arin')).toBe('https://rdap.arin.net/registry/');
    const hosts = await boot.rdapHosts();
    expect(hosts.has('rdap.arin.net')).toBe(true);
    expect(hosts.has('rdap.example.org')).toBe(false);
    await expect(boot.baseUrl('lacnic')).rejects.toBeInstanceOf(RdapError);
  });

  it('fetches the three IANA files once while fresh', async () => {
    const { boot, fetch } = setup();
    await Promise.all([boot.routeIp(parseIpOrCidr('1.1.1.1')), boot.routeAsn(4608), boot.routeIp(parseIpOrCidr('8.8.8.8'))]);
    expect(fetch.calls).toHaveLength(3);
  });

  it('keeps using stale data when IANA is down after expiry', async () => {
    const { fetch, clock, cache } = setup();
    const first = new Bootstrap({ http: { fetch, userAgent: 't' }, cache, clock });
    await first.routeAsn(4608);
    clock.advance(25 * 3_600_000);
    const down = setup(true);
    const second = new Bootstrap({ http: { fetch: down.fetch, userAgent: 't' }, cache, clock });
    expect((await second.routeAsn(4608))?.rir).toBe('apnic');
  });

  it('throws when IANA is down and nothing is cached', async () => {
    const { boot } = setup(true);
    await expect(boot.routeAsn(4608)).rejects.toBeInstanceOf(RdapError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/rdap/bootstrap.test.ts`
Expected: FAIL — cannot resolve `../../src/rdap/bootstrap`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/rdap/bootstrap.ts`:
```ts
import { parseIpOrCidr, prefixContains, type IpPrefix } from '../input/ip';
import type { CacheStore, Clock } from '../ports';
import { fetchJson, type HttpDeps } from './client';
import { RdapError } from './errors';
import { RIR_HOSTS, type Rir } from './rirs';

export const IANA_BOOTSTRAP_BASE = 'https://data.iana.org/rdap/';
const FILES = ['ipv4', 'ipv6', 'asn'] as const;
const CACHE_KEY = 'iana:bootstrap:v1';
const FRESH_MS = 24 * 3_600_000;
const STALE_MS = 7 * 24 * 3_600_000;

type Service = [string[], string[]];
interface RawFile { readonly services: readonly Service[] }
type RawBootstrap = Readonly<Record<(typeof FILES)[number], RawFile>>;

export interface Route {
  readonly rir: Rir;
  readonly baseUrl: string;
}

interface Index {
  readonly ip: Array<{ prefix: IpPrefix; route: Route }>;
  readonly asn: Array<{ start: number; end: number; route: Route }>;
  readonly bases: Map<Rir, string>;
  readonly hosts: Set<string>;
}

/** Routes queries to the authoritative RIR using the IANA RDAP bootstrap files (RFC 9224). */
export class Bootstrap {
  private readonly http: HttpDeps;
  private readonly cache: CacheStore;
  private readonly clock: Clock;
  private parsed: { fetchedAt: number; index: Index } | null = null;
  private inflight: Promise<RawBootstrap> | null = null;

  constructor(deps: { http: HttpDeps; cache: CacheStore; clock: Clock }) {
    this.http = deps.http;
    this.cache = deps.cache;
    this.clock = deps.clock;
  }

  async routeIp(p: IpPrefix): Promise<Route | null> {
    const { ip } = await this.index();
    let best: { prefix: IpPrefix; route: Route } | null = null;
    for (const e of ip) {
      if (prefixContains(e.prefix, p) && (!best || e.prefix.length > best.prefix.length)) best = e;
    }
    return best ? best.route : null;
  }

  async routeAsn(n: number): Promise<Route | null> {
    const { asn } = await this.index();
    return asn.find((e) => n >= e.start && n <= e.end)?.route ?? null;
  }

  async baseUrl(rir: Rir): Promise<string> {
    const base = (await this.index()).bases.get(rir);
    if (!base) throw new RdapError('upstream', `The IANA bootstrap lists no RDAP service for ${rir}`);
    return base;
  }

  async rdapHosts(): Promise<ReadonlySet<string>> {
    return (await this.index()).hosts;
  }

  private async index(): Promise<Index> {
    const entry = await this.cache.get<RawBootstrap>(CACHE_KEY);
    if (entry && this.clock.now() < entry.freshUntil) return this.parse(entry.value, entry.fetchedAt);
    try {
      const raw = await this.fetchAll();
      const t = this.clock.now();
      await this.cache.put(CACHE_KEY, { value: raw, fetchedAt: t, freshUntil: t + FRESH_MS, staleUntil: t + STALE_MS });
      return this.parse(raw, t);
    } catch (err) {
      if (entry) return this.parse(entry.value, entry.fetchedAt);
      if (err instanceof RdapError) throw new RdapError('upstream', `IANA RDAP bootstrap unavailable (${err.code})`);
      throw err;
    }
  }

  private fetchAll(): Promise<RawBootstrap> {
    this.inflight ??= (async () => {
      const [ipv4, ipv6, asn] = await Promise.all(
        FILES.map((f) => fetchJson(`${IANA_BOOTSTRAP_BASE}${f}.json`, { maxBytes: 1_000_000 }, this.http)),
      );
      return { ipv4: asRawFile(ipv4), ipv6: asRawFile(ipv6), asn: asRawFile(asn) };
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private parse(raw: RawBootstrap, fetchedAt: number): Index {
    if (this.parsed?.fetchedAt === fetchedAt) return this.parsed.index;
    const index: Index = { ip: [], asn: [], bases: new Map(), hosts: new Set() };
    const routeOf = (urls: readonly string[]): Route | null => {
      const https = urls.find((u) => u.startsWith('https://'));
      if (!https) return null;
      const host = new URL(https).hostname;
      const rir = RIR_HOSTS[host];
      if (!rir) return null;
      const baseUrl = https.endsWith('/') ? https : `${https}/`;
      index.bases.set(rir, baseUrl);
      index.hosts.add(host);
      return { rir, baseUrl };
    };
    for (const file of [raw.ipv4, raw.ipv6]) {
      for (const [ranges, urls] of file.services) {
        const route = routeOf(urls);
        if (!route) continue;
        for (const r of ranges) {
          try {
            index.ip.push({ prefix: parseIpOrCidr(r), route });
          } catch {
            // Skip a malformed IANA entry rather than failing every lookup.
          }
        }
      }
    }
    for (const [ranges, urls] of raw.asn.services) {
      const route = routeOf(urls);
      if (!route) continue;
      for (const r of ranges) {
        const [a, b] = r.split('-');
        const start = Number(a);
        const end = Number(b ?? a);
        if (Number.isInteger(start) && Number.isInteger(end)) index.asn.push({ start, end, route });
      }
    }
    this.parsed = { fetchedAt, index };
    return index;
  }
}

function asRawFile(v: unknown): RawFile {
  const services = (v as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) throw new RdapError('bad_response', 'IANA bootstrap file has no services array');
  return { services: services as Service[] };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/core/test/rdap && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): route queries to the authoritative RIR via IANA bootstrap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: jCard helpers, fixture scrubbing, recorded fixtures and PII lint

**Files:**
- Create: `packages/core/src/reduce/vcard.ts`, `packages/core/test/support/scrub.ts`, `packages/core/test/support/fixtures.ts`, `scripts/fixtures-record.ts`
- Create (generated): `fixtures/iana/*.json`, `fixtures/rdap/**/*.json`
- Test: `packages/core/test/reduce/vcard.test.ts`, `packages/core/test/fixtures-lint.test.ts`

**Interfaces:**
- Consumes: `Rir` (Task 2).
- Produces: `vcardProps(entity: unknown)`, `vcardValue(entity: unknown, name: string): string | undefined`, `vcardValues(entity: unknown, name: string): string[]`, `entityKind(entity: unknown): string | undefined` (lower-cased), `isPersonLike(entity: unknown): boolean` (true unless kind is `org` or `group`); test helpers `scrubRdap(doc: unknown): unknown`, `FIXTURES_DIR`, `loadFixture(rel: string): unknown`, `listFixtures(sub?: string): string[]`, `rdapFixtures(kinds: string[]): string[]`, `rirOf(rel: string): Rir`, `ianaRoutes(): Record<string, FakeRoute>`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/reduce/vcard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { entityKind, isPersonLike, vcardValue, vcardValues } from '../../src/reduce/vcard';
import { scrubRdap } from '../support/scrub';

const entity = (kind: string | null, extra: unknown[] = []) => ({
  handle: 'H-1',
  vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Real Name'],
    ...(kind ? [['kind', {}, 'text', kind]] : []), ['email', {}, 'text', 'a@b.c'], ['email', {}, 'text', 'd@e.f'], ...extra]],
});

describe('vcard helpers', () => {
  it('reads values', () => {
    expect(vcardValue(entity('org'), 'fn')).toBe('Real Name');
    expect(vcardValues(entity('org'), 'email')).toEqual(['a@b.c', 'd@e.f']);
    expect(entityKind(entity('ORG'))).toBe('org');
    expect(vcardValue({}, 'fn')).toBeUndefined();
    expect(vcardValue({ vcardArray: 'junk' }, 'fn')).toBeUndefined();
  });

  it('treats anything but org/group as a person', () => {
    expect(isPersonLike(entity('org'))).toBe(false);
    expect(isPersonLike(entity('group'))).toBe(false);
    expect(isPersonLike(entity('individual'))).toBe(true);
    expect(isPersonLike(entity(null))).toBe(true);
    expect(isPersonLike({})).toBe(true);
  });
});

describe('scrubRdap', () => {
  it('replaces people and remarks, keeps orgs and structure', () => {
    const doc = {
      objectClassName: 'ip network',
      remarks: [{ title: 'r', description: ['call Jane on 555'] }],
      entities: [
        { ...entity('org'), roles: ['registrant'], entities: [{ ...entity('individual'), roles: ['technical'], links: [{ href: 'x' }] }] },
        { ...entity(null), roles: ['abuse'] },
      ],
    };
    const out = scrubRdap(doc) as typeof doc;
    const json = JSON.stringify(out);
    expect(json).not.toContain('555');
    expect(json).not.toContain('Jane');
    expect(vcardValue(out.entities[0], 'fn')).toBe('Real Name');
    const person = (out.entities[0] as { entities: unknown[] }).entities[0];
    expect(vcardValue(person, 'fn')).toBe('Example Person 1');
    expect((person as { handle: string }).handle).toBe('EXAMPLE-PERSON-1');
    expect((person as { links?: unknown }).links).toBeUndefined();
    expect(vcardValue(out.entities[1], 'fn')).toBe('Example Person 2');
    expect(out.remarks[0]?.description).toEqual(['[scrubbed]']);
  });
});
```

`packages/core/test/fixtures-lint.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isPersonLike, vcardValue, vcardValues } from '../src/reduce/vcard';
import { listFixtures, loadFixture } from './support/fixtures';

function collect(node: unknown, people: unknown[], notes: unknown[][]): void {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, people, notes)); return; }
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if ('vcardArray' in obj && isPersonLike(obj)) people.push(obj);
  if (Array.isArray(obj.remarks)) notes.push(obj.remarks);
  Object.values(obj).forEach((v) => collect(v, people, notes));
}

describe('committed RDAP fixtures hold no real personal data', () => {
  const files = listFixtures('rdap');

  it('exist', () => {
    expect(files.length).toBeGreaterThanOrEqual(16);
  });

  it.each(files)('%s', (rel) => {
    const people: unknown[] = [];
    const notes: unknown[][] = [];
    collect(loadFixture(rel), people, notes);
    for (const p of people) {
      expect(vcardValue(p, 'fn')).toMatch(/^Example Person \d+$/);
      for (const email of vcardValues(p, 'email')) expect(email).toMatch(/^person-\d+@example\.net$/);
      expect((p as { handle?: string }).handle).toMatch(/^EXAMPLE-PERSON-\d+$/);
    }
    for (const list of notes) {
      for (const note of list) expect((note as { description?: unknown }).description).toEqual(['[scrubbed]']);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/reduce/vcard.test.ts packages/core/test/fixtures-lint.test.ts`
Expected: FAIL — cannot resolve `../../src/reduce/vcard`.

- [ ] **Step 3: Write the helpers and scrubber**

`packages/core/src/reduce/vcard.ts`:
```ts
/** Helpers for jCard (RFC 7095) arrays inside RDAP entities. */
export type JCardProp = [string, Record<string, unknown>, string, unknown];

export function vcardProps(entity: unknown): JCardProp[] {
  const arr = (entity as { vcardArray?: unknown } | null)?.vcardArray;
  if (!Array.isArray(arr) || arr[0] !== 'vcard' || !Array.isArray(arr[1])) return [];
  return (arr[1] as unknown[]).filter(
    (p): p is JCardProp => Array.isArray(p) && p.length >= 4 && typeof p[0] === 'string',
  );
}

export function vcardValues(entity: unknown, name: string): string[] {
  return vcardProps(entity)
    .filter((p) => p[0] === name && typeof p[3] === 'string')
    .map((p) => p[3] as string);
}

export function vcardValue(entity: unknown, name: string): string | undefined {
  return vcardValues(entity, name)[0];
}

export function entityKind(entity: unknown): string | undefined {
  return vcardValue(entity, 'kind')?.toLowerCase();
}

/** Conservative PII rule (spec §4): anything not explicitly an org or group is a person. */
export function isPersonLike(entity: unknown): boolean {
  const kind = entityKind(entity);
  return kind !== 'org' && kind !== 'group';
}
```

`packages/core/test/support/scrub.ts`:
```ts
import { isPersonLike } from '../../src/reduce/vcard';

/**
 * Replaces every person-like entity's identifying values with synthetic ones and blanks
 * remarks/notices text, keeping structure (nesting, roles, kind) for reducer tests.
 */
export function scrubRdap(doc: unknown): unknown {
  let n = 0;
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node === null || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = k === 'remarks' || k === 'notices' ? scrubNotes(v) : visit(v);
    }
    if ('vcardArray' in obj && isPersonLike(obj)) {
      n += 1;
      out.handle = `EXAMPLE-PERSON-${n}`;
      out.vcardArray = ['vcard', [
        ['version', {}, 'text', '4.0'],
        ['fn', {}, 'text', `Example Person ${n}`],
        ['kind', {}, 'text', 'individual'],
        ['email', {}, 'text', `person-${n}@example.net`],
        ['tel', { type: 'voice' }, 'uri', 'tel:+00-0000-0000'],
      ]];
      delete out.links;
    }
    return out;
  };
  return visit(doc);
}

function scrubNotes(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v.map((note) => ({ ...(note as Record<string, unknown>), description: ['[scrubbed]'] }));
}
```

`packages/core/test/support/fixtures.ts`:
```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rir } from '../../src/rdap/rirs';
import type { FakeRoute } from './fake-fetch';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));

export function loadFixture(rel: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, rel), 'utf8')) as unknown;
}

export function listFixtures(sub = ''): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.json')) out.push(relative(FIXTURES_DIR, p));
    }
  };
  walk(join(FIXTURES_DIR, sub));
  return out.sort();
}

/** Fixture paths look like rdap/<rir>/<kind>/<case>.json. */
export function rdapFixtures(kinds: readonly string[]): string[] {
  return listFixtures('rdap').filter((rel) => kinds.includes(rel.split('/')[2] ?? ''));
}

export function rirOf(rel: string): Rir {
  return rel.split('/')[1] as Rir;
}

export function ianaRoutes(): Record<string, FakeRoute> {
  const base = 'https://data.iana.org/rdap/';
  return {
    [`${base}ipv4.json`]: { body: loadFixture('iana/ipv4.json') },
    [`${base}ipv6.json`]: { body: loadFixture('iana/ipv6.json') },
    [`${base}asn.json`]: { body: loadFixture('iana/asn.json') },
  };
}
```

`scripts/fixtures-record.ts`:
```ts
/**
 * Records RDAP fixtures from the live RIRs, scrubbing personal data before writing.
 * Usage: RIR_MCP_OPERATOR=you@example.net pnpm fixtures:record
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildUserAgent } from '../packages/core/src/rdap/user-agent';
import { scrubRdap } from '../packages/core/test/support/scrub';

const FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ['iana/ipv4.json', 'https://data.iana.org/rdap/ipv4.json'],
  ['iana/ipv6.json', 'https://data.iana.org/rdap/ipv6.json'],
  ['iana/asn.json', 'https://data.iana.org/rdap/asn.json'],
  ['rdap/apnic/ip/1.1.1.1.json', 'https://rdap.apnic.net/ip/1.1.1.1'],
  ['rdap/apnic/ip/2001_dc0__1.json', 'https://rdap.apnic.net/ip/2001:dc0::1'],
  ['rdap/apnic/autnum/4608.json', 'https://rdap.apnic.net/autnum/4608'],
  ['rdap/apnic/entity/ORG-ARAD1-AP.json', 'https://rdap.apnic.net/entity/ORG-ARAD1-AP'],
  ['rdap/apnic/domain/1.1.1.in-addr.arpa.json', 'https://rdap.apnic.net/domain/1.1.1.in-addr.arpa'],
  ['rdap/apnic/domain/0.c.d.0.1.0.0.2.ip6.arpa.json', 'https://rdap.apnic.net/domain/0.c.d.0.1.0.0.2.ip6.arpa'],
  ['rdap/apnic/history-ip/1.1.1.1.json', 'https://rdap.apnic.net/history/ip/1.1.1.1'],
  ['rdap/apnic/history-autnum/4608.json', 'https://rdap.apnic.net/history/autnum/4608'],
  ['rdap/arin/ip/8.8.8.8.json', 'https://rdap.arin.net/registry/ip/8.8.8.8'],
  ['rdap/arin/autnum/15169.json', 'https://rdap.arin.net/registry/autnum/15169'],
  ['rdap/ripe/ip/193.0.6.139.json', 'https://rdap.db.ripe.net/ip/193.0.6.139'],
  ['rdap/ripe/autnum/3333.json', 'https://rdap.db.ripe.net/autnum/3333'],
  ['rdap/lacnic/ip/200.3.14.10.json', 'https://rdap.lacnic.net/rdap/ip/200.3.14.10'],
  ['rdap/lacnic/autnum/28000.json', 'https://rdap.lacnic.net/rdap/autnum/28000'],
  ['rdap/afrinic/ip/196.216.2.1.json', 'https://rdap.afrinic.net/rdap/ip/196.216.2.1'],
  ['rdap/afrinic/autnum/33764.json', 'https://rdap.afrinic.net/rdap/autnum/33764'],
];

const userAgent = buildUserAgent(process.env.RIR_MCP_OPERATOR ?? '');

for (const [rel, url] of FIXTURES) {
  const res = await fetch(url, { headers: { accept: 'application/rdap+json, application/json', 'user-agent': userAgent } });
  if (!res.ok) {
    console.error(`FAIL ${res.status} ${url}`);
    process.exitCode = 1;
    continue;
  }
  const raw: unknown = await res.json();
  const doc = rel.startsWith('rdap/') ? scrubRdap(raw) : raw;
  const path = join('fixtures', rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`ok   ${rel}`);
  await new Promise((resolve) => setTimeout(resolve, 1500)); // well under every RIR's limit
}
```

- [ ] **Step 4: Record the fixtures (network required, ~30 s)**

Run: `RIR_MCP_OPERATOR=<your contact email> pnpm fixtures:record`
Expected: 19 lines starting `ok`, no `FAIL`. If a URL fails, re-run once; if it still fails, stop and report the URL and status.

- [ ] **Step 5: Run tests and inspect a fixture by eye**

Run: `pnpm vitest run packages/core/test/reduce/vcard.test.ts packages/core/test/fixtures-lint.test.ts`
Expected: PASS (lint covers 16 RDAP files).
Then: `grep -c 'Example Person' fixtures/rdap/ripe/ip/193.0.6.139.json` — Expected: a count ≥ 1 (RIPE returns people; they were replaced).

- [ ] **Step 6: Commit**

```bash
git add packages/core scripts fixtures
git commit -m "test: record scrubbed RDAP fixtures and lint them for personal data

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Reducers for current records

**Files:**
- Create: `packages/core/src/reduce/sanitize.ts`, `util.ts`, `types.ts`, `entities.ts`, `network.ts`, `autnum.ts`, `entity.ts`, `domain.ts`
- Test: `packages/core/test/reduce/reducers.test.ts`, `packages/core/test/reduce/fixtures.test.ts`

**Interfaces:**
- Consumes: vcard helpers (Task 7); `parseIpOrCidr`, `formatCidr`, `rangeToCidrs` (Task 1); `RdapError` (Task 5); `Rir` (Task 2); fixture helpers (Task 7).
- Produces:
  - `clean(value: unknown, max = 120): string | undefined` — strips control, bidi and zero-width characters, collapses whitespace, truncates with `…`.
  - `type Obj = Record<string, unknown>`; `asObject(v): Obj`; `strings(v, max = 40): string[]`; `eventDate(o: Obj, action: string): string | undefined` (YYYY-MM-DD); `expectClass(raw: unknown, cls: string): Obj` (throws `RdapError('bad_response')`).
  - Types: `Contact { handle; name?; email? }`, `Personal { personal: true }`, `Party = Contact | Personal`, `isPersonal(p)`, `ReduceCtx { rir }`, `NetworkRecord`, `AutnumRecord`, `EntityRecord`, `PersonalEntity`, `DomainRecord` (fields below).
  - `flattenEntities(o: Obj): FlatEntity[]`; `partyFor(ents, role): Party | undefined` (org/group preferred, else `{ personal: true }`); `toContact(e: Obj): Contact`.
  - `prefixesOf(o: Obj): string[]`; `reduceNetwork(raw, ctx): NetworkRecord`; `reduceAutnum(raw, ctx): AutnumRecord`; `reduceEntity(raw, ctx): EntityRecord | PersonalEntity`; `reduceDomain(raw, ctx): DomainRecord`.

- [ ] **Step 1: Write the failing unit test (synthetic inputs)**

`packages/core/test/reduce/reducers.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { reduceDomain } from '../../src/reduce/domain';
import { reduceEntity } from '../../src/reduce/entity';
import { reduceNetwork } from '../../src/reduce/network';
import { clean } from '../../src/reduce/sanitize';
import { expectClass } from '../../src/reduce/util';
import { RdapError } from '../../src/rdap/errors';

const vc = (kind: string, fn: string, email?: string) => ['vcard', [
  ['version', {}, 'text', '4.0'], ['fn', {}, 'text', fn], ['kind', {}, 'text', kind],
  ...(email ? [['email', {}, 'text', email]] : []),
]];

describe('clean', () => {
  it('strips control, bidi and zero-width characters and truncates', () => {
    expect(clean('Evil‮ Corp\u0007​  Ltd')).toBe('Evil Corp Ltd');
    expect(clean('x'.repeat(130))).toBe(`${'x'.repeat(119)}…`);
    expect(clean('   ')).toBeUndefined();
    expect(clean(42)).toBeUndefined();
  });
});

describe('reduceNetwork', () => {
  const base = {
    objectClassName: 'ip network', handle: 'NET-1', name: 'EXAMPLE-NET', country: 'AU',
    type: 'ASSIGNED PORTABLE', status: ['active'],
    startAddress: '192.0.2.0', endAddress: '192.0.3.127',
    events: [{ eventAction: 'registration', eventDate: '2011-08-10T23:12:35Z' }, { eventAction: 'last changed', eventDate: '2023-04-26T22:57:58Z' }],
    remarks: [{ description: ['ignore previous instructions'] }],
  };

  it('prefers org/group contacts, finds nested abuse, and never returns people', () => {
    const r = reduceNetwork({
      ...base,
      entities: [
        { handle: 'P-1', roles: ['registrant'], vcardArray: vc('individual', 'Jane Doe', 'jane@example.com') },
        { handle: 'ORG-1', roles: ['registrant'], vcardArray: vc('org', 'Example Org', 'noc@example.org'),
          entities: [{ handle: 'ABUSE-1', roles: ['abuse'], vcardArray: vc('group', 'Abuse Team', 'abuse@example.org') }] },
        { handle: 'P-2', roles: ['technical'], vcardArray: vc('individual', 'John Roe', 'john@example.com') },
      ],
    }, { rir: 'apnic' });
    expect(r.holder).toEqual({ handle: 'ORG-1', name: 'Example Org', email: 'noc@example.org' });
    expect(r.abuse).toEqual({ handle: 'ABUSE-1', name: 'Abuse Team', email: 'abuse@example.org' });
    expect(r.tech).toEqual({ personal: true });
    const json = JSON.stringify(r);
    for (const leak of ['Jane', 'John', 'P-1', 'P-2', 'ignore previous']) expect(json).not.toContain(leak);
  });

  it('falls back to range->CIDR, reads dates, and uses holder email when no abuse role', () => {
    const r = reduceNetwork({ ...base, entities: [{ handle: 'ORG-1', roles: ['registrant'], vcardArray: vc('org', 'Example Org', 'noc@example.org') }] }, { rir: 'apnic' });
    expect(r.prefixes).toEqual(['192.0.2.0/24', '192.0.3.0/25']);
    expect(r.registered).toBe('2011-08-10');
    expect(r.changed).toBe('2023-04-26');
    expect(r.abuse).toMatchObject({ email: 'noc@example.org' });
  });

  it('marks a personal abuse contact instead of falling back', () => {
    const r = reduceNetwork({ ...base, entities: [
      { handle: 'ORG-1', roles: ['registrant'], vcardArray: vc('org', 'Example Org', 'noc@example.org') },
      { handle: 'P-3', roles: ['abuse', 'technical'], vcardArray: vc('individual', 'Ann Lee', 'ann@example.com') },
    ] }, { rir: 'lacnic' });
    expect(r.abuse).toEqual({ personal: true });
  });

  it('prefers cidr0 prefixes', () => {
    const r = reduceNetwork({ ...base, cidr0_cidrs: [{ v4prefix: '192.0.2.0', length: 23 }] }, { rir: 'apnic' });
    expect(r.prefixes).toEqual(['192.0.2.0/23']);
  });
});

describe('reduceEntity and reduceDomain', () => {
  it('refuses person entities', () => {
    expect(reduceEntity({ objectClassName: 'entity', handle: 'P-1', vcardArray: vc('individual', 'Jane Doe') }, { rir: 'apnic' }))
      .toEqual({ type: 'personal-entity', rir: 'apnic' });
  });

  it('normalises zones and nameservers and reads DNSSEC', () => {
    const d = reduceDomain({
      objectClassName: 'domain', ldhName: '1.1.1.IN-ADDR.ARPA.',
      nameservers: [{ ldhName: 'NS1.Example.NET.' }], secureDNS: { delegationSigned: true },
    }, { rir: 'apnic' });
    expect(d).toMatchObject({ zone: '1.1.1.in-addr.arpa', nameservers: ['ns1.example.net'], signed: true });
  });
});

describe('expectClass', () => {
  it('rejects non-RDAP or wrong-class payloads', () => {
    expect(() => expectClass([], 'ip network')).toThrow(RdapError);
    expect(() => expectClass({ objectClassName: 'autnum' }, 'ip network')).toThrow(RdapError);
  });
});
```

- [ ] **Step 2: Write the failing fixture test**

`packages/core/test/reduce/fixtures.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { reduceAutnum } from '../../src/reduce/autnum';
import { reduceDomain } from '../../src/reduce/domain';
import { reduceEntity } from '../../src/reduce/entity';
import { reduceNetwork } from '../../src/reduce/network';
import { asObject } from '../../src/reduce/util';
import { loadFixture, rdapFixtures, rirOf } from '../support/fixtures';

const REDUCERS = { ip: reduceNetwork, autnum: reduceAutnum, entity: reduceEntity, domain: reduceDomain } as const;
const CLASS = { ip: 'ip network', autnum: 'autnum', entity: 'entity', domain: 'domain' } as const;
type Kind = keyof typeof REDUCERS;

export function reduceFixture(rel: string): unknown {
  const kind = rel.split('/')[2] as Kind;
  return REDUCERS[kind](loadFixture(rel), { rir: rirOf(rel) });
}

describe('reducers on recorded fixtures', () => {
  it.each(rdapFixtures(Object.keys(REDUCERS)))('%s: class, no leaks, snapshot', (rel) => {
    const kind = rel.split('/')[2] as Kind;
    expect(asObject(loadFixture(rel)).objectClassName).toBe(CLASS[kind]);
    const record = reduceFixture(rel);
    const json = JSON.stringify(record);
    for (const marker of ['Example Person', 'example.net', 'EXAMPLE-PERSON', '[scrubbed]']) {
      expect(json).not.toContain(marker);
    }
    expect(record).toMatchSnapshot();
  });

  it('APNIC 1.1.1.1', () => {
    const r = reduceNetwork(loadFixture('rdap/apnic/ip/1.1.1.1.json'), { rir: 'apnic' });
    expect(r.prefixes).toEqual(['1.1.1.0/24']);
    expect(r.name).toBe('APNIC-LABS');
    expect(r.country).toBe('AU');
    expect(r.holder).toMatchObject({ handle: 'ORG-ARAD1-AP', name: 'APNIC Research and Development' });
    expect(r.abuse).toMatchObject({ handle: 'IRT-APNICRANDNET-AU', email: 'helpdesk@apnic.net' });
    expect(r.registered).toBe('2011-08-10');
  });

  it('APNIC 2001:dc0::1', () => {
    const r = reduceNetwork(loadFixture('rdap/apnic/ip/2001_dc0__1.json'), { rir: 'apnic' });
    expect(r.name).toBe('APNIC-AP-V6-JP');
    expect(r.prefixes).toEqual(['2001:dc0::/35']);
  });

  it('ARIN 8.8.8.8 and AS15169', () => {
    const net = reduceNetwork(loadFixture('rdap/arin/ip/8.8.8.8.json'), { rir: 'arin' });
    expect(net.prefixes).toEqual(['8.8.8.0/24']);
    expect(net.name).toBe('GOGL');
    expect(net.holder).toHaveProperty('handle');
    expect(net.abuse).toHaveProperty('handle');
    expect(reduceAutnum(loadFixture('rdap/arin/autnum/15169.json'), { rir: 'arin' }).name).toBe('GOOGLE');
  });

  it('RIPE 193.0.6.139 and AS3333: org holder despite individual registrants', () => {
    const net = reduceNetwork(loadFixture('rdap/ripe/ip/193.0.6.139.json'), { rir: 'ripe' });
    expect(net.name).toBe('RIPE-NCC');
    expect(net.prefixes).toEqual(['193.0.0.0/21']);
    expect(net.holder).toHaveProperty('handle');
    expect(net.abuse).toHaveProperty('handle');
    expect(reduceAutnum(loadFixture('rdap/ripe/autnum/3333.json'), { rir: 'ripe' }).name).toBe('RIPE-NCC-AS');
  });

  it('LACNIC 200.3.14.10: personal abuse and tech contacts', () => {
    const net = reduceNetwork(loadFixture('rdap/lacnic/ip/200.3.14.10.json'), { rir: 'lacnic' });
    expect(net.prefixes).toEqual(['200.3.12.0/22']);
    expect(net.abuse).toEqual({ personal: true });
    expect(net.tech).toEqual({ personal: true });
  });

  it('AFRINIC 196.216.2.1: org holder, personal tech/admin', () => {
    const net = reduceNetwork(loadFixture('rdap/afrinic/ip/196.216.2.1.json'), { rir: 'afrinic' });
    expect(net.prefixes).toEqual(['196.216.2.0/23']);
    expect(net.holder).toHaveProperty('handle');
    expect(net.tech).toEqual({ personal: true });
    expect(net.admin).toEqual({ personal: true });
  });

  it('APNIC AS4608, ORG-ARAD1-AP, 1.1.1.in-addr.arpa', () => {
    const as = reduceAutnum(loadFixture('rdap/apnic/autnum/4608.json'), { rir: 'apnic' });
    expect([as.asnStart, as.asnEnd]).toEqual([4608, 4608]);
    expect(reduceEntity(loadFixture('rdap/apnic/entity/ORG-ARAD1-AP.json'), { rir: 'apnic' }))
      .toMatchObject({ type: 'entity', kind: 'org', name: 'APNIC Research and Development' });
    expect(reduceDomain(loadFixture('rdap/apnic/domain/1.1.1.in-addr.arpa.json'), { rir: 'apnic' }))
      .toMatchObject({ zone: '1.1.1.in-addr.arpa', nameservers: ['alec.ns.cloudflare.com', 'mira.ns.cloudflare.com'], signed: false });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/reduce`
Expected: FAIL — cannot resolve `../../src/reduce/domain`.

- [ ] **Step 4: Write the implementation**

`packages/core/src/reduce/sanitize.ts`:
```ts
// C0/C1 controls, zero-width, bidi embeddings/overrides/isolates, BOM.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** Registry text is data, never instructions: strip unsafe characters and cap length. */
export function clean(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
```

`packages/core/src/reduce/util.ts`:
```ts
import { RdapError } from '../rdap/errors';
import { clean } from './sanitize';

export type Obj = Record<string, unknown>;

export function asObject(v: unknown): Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

export function strings(v: unknown, max = 40): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const c = clean(x, max);
    return c ? [c] : [];
  });
}

export function eventDate(o: Obj, action: string): string | undefined {
  if (!Array.isArray(o.events)) return undefined;
  for (const raw of o.events) {
    const e = asObject(raw);
    if (e.eventAction === action && typeof e.eventDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e.eventDate)) {
      return e.eventDate.slice(0, 10);
    }
  }
  return undefined;
}

export function expectClass(raw: unknown, cls: string): Obj {
  const o = asObject(raw);
  if (o.objectClassName !== cls) throw new RdapError('bad_response', `Expected an RDAP "${cls}" object`);
  return o;
}
```

`packages/core/src/reduce/types.ts`:
```ts
import type { Rir } from '../rdap/rirs';

export interface Contact {
  readonly handle: string;
  readonly name?: string;
  readonly email?: string;
}

/** A contact that exists but is a person: never disclosed. */
export interface Personal {
  readonly personal: true;
}

export type Party = Contact | Personal;

export function isPersonal(p: Party | undefined): p is Personal {
  return p !== undefined && 'personal' in p;
}

export interface ReduceCtx {
  readonly rir: Rir;
}

interface Registered {
  readonly rir: Rir;
  readonly handle: string;
  readonly name?: string;
  readonly country?: string;
  readonly status: readonly string[];
  readonly holder?: Party;
  readonly abuse?: Party;
  readonly tech?: Party;
  readonly admin?: Party;
  readonly registered?: string;
  readonly changed?: string;
}

export interface NetworkRecord extends Registered {
  readonly type: 'network';
  readonly prefixes: readonly string[];
  readonly allocationType?: string;
}

export interface AutnumRecord extends Registered {
  readonly type: 'autnum';
  readonly asnStart?: number;
  readonly asnEnd?: number;
}

export interface EntityRecord {
  readonly type: 'entity';
  readonly rir: Rir;
  readonly handle: string;
  readonly kind: 'org' | 'group';
  readonly name?: string;
  readonly email?: string;
  readonly roles: readonly string[];
  readonly registered?: string;
  readonly changed?: string;
}

export interface PersonalEntity {
  readonly type: 'personal-entity';
  readonly rir: Rir;
}

export interface DomainRecord {
  readonly type: 'domain';
  readonly rir: Rir;
  readonly zone: string;
  readonly nameservers: readonly string[];
  readonly signed: boolean;
  readonly registered?: string;
  readonly changed?: string;
}
```

`packages/core/src/reduce/entities.ts`:
```ts
import { clean } from './sanitize';
import type { Contact, Party } from './types';
import { asObject, type Obj } from './util';
import { isPersonLike, vcardValue, vcardValues } from './vcard';

export interface FlatEntity {
  readonly entity: Obj;
  readonly roles: readonly string[];
}

/** All entities with their roles, including nested ones (ARIN/RIPE nest abuse under the org). */
export function flattenEntities(o: Obj, depth = 0): FlatEntity[] {
  if (depth > 3 || !Array.isArray(o.entities)) return [];
  return o.entities.flatMap((raw) => {
    const entity = asObject(raw);
    const roles = Array.isArray(entity.roles) ? entity.roles.filter((r): r is string => typeof r === 'string') : [];
    return [{ entity, roles }, ...flattenEntities(entity, depth + 1)];
  });
}

export function toContact(e: Obj): Contact {
  return {
    handle: clean(e.handle, 64) ?? 'UNKNOWN',
    name: clean(vcardValue(e, 'fn')),
    email: clean(vcardValues(e, 'email')[0], 254),
  };
}

/** Org/group contact for a role if any; otherwise mark the role as held by a person. */
export function partyFor(ents: readonly FlatEntity[], role: string): Party | undefined {
  const matches = ents.filter((x) => x.roles.includes(role));
  if (matches.length === 0) return undefined;
  const org = matches.find((x) => !isPersonLike(x.entity));
  return org ? toContact(org.entity) : { personal: true };
}
```

`packages/core/src/reduce/network.ts`:
```ts
import { formatCidr, parseIpOrCidr, rangeToCidrs } from '../input/ip';
import { flattenEntities, partyFor, type FlatEntity } from './entities';
import { clean } from './sanitize';
import { isPersonal, type NetworkRecord, type Party, type ReduceCtx } from './types';
import { asObject, eventDate, strings, type Obj } from './util';

export function prefixesOf(o: Obj): string[] {
  const out: string[] = [];
  if (Array.isArray(o.cidr0_cidrs)) {
    for (const raw of o.cidr0_cidrs) {
      const c = asObject(raw);
      const base = c.v4prefix ?? c.v6prefix;
      if (typeof base !== 'string' || typeof c.length !== 'number') continue;
      try {
        out.push(formatCidr(parseIpOrCidr(`${base}/${c.length}`)));
      } catch {
        // Ignore a malformed cidr0 entry; the range fallback may still work.
      }
    }
  }
  if (out.length > 0) return out;
  if (typeof o.startAddress === 'string' && typeof o.endAddress === 'string') {
    try {
      const a = parseIpOrCidr(o.startAddress);
      const b = parseIpOrCidr(o.endAddress);
      if (a.family === b.family && a.value <= b.value) return rangeToCidrs(a.family, a.value, b.value).map((p) => formatCidr(p));
    } catch {
      // Malformed range: no prefixes.
    }
  }
  return [];
}

/** Abuse role if present; else the holder's own email (only if the holder is an org/group). */
export function abuseParty(ents: readonly FlatEntity[], holder: Party | undefined): Party | undefined {
  const abuse = partyFor(ents, 'abuse');
  if (abuse) return abuse;
  return holder && !isPersonal(holder) && holder.email ? holder : undefined;
}

export function reduceNetwork(raw: unknown, ctx: ReduceCtx): NetworkRecord {
  const o = asObject(raw);
  const ents = flattenEntities(o);
  const holder = partyFor(ents, 'registrant');
  return {
    type: 'network',
    rir: ctx.rir,
    handle: clean(o.handle, 64) ?? 'UNKNOWN',
    prefixes: prefixesOf(o),
    name: clean(o.name),
    country: clean(o.country, 3),
    allocationType: clean(o.type, 40),
    status: strings(o.status),
    holder,
    abuse: abuseParty(ents, holder),
    tech: partyFor(ents, 'technical'),
    admin: partyFor(ents, 'administrative'),
    registered: eventDate(o, 'registration'),
    changed: eventDate(o, 'last changed'),
  };
}
```

`packages/core/src/reduce/autnum.ts`:
```ts
import { flattenEntities, partyFor } from './entities';
import { abuseParty } from './network';
import { clean } from './sanitize';
import type { AutnumRecord, ReduceCtx } from './types';
import { asObject, eventDate, strings } from './util';

export function reduceAutnum(raw: unknown, ctx: ReduceCtx): AutnumRecord {
  const o = asObject(raw);
  const ents = flattenEntities(o);
  const holder = partyFor(ents, 'registrant');
  const start = typeof o.startAutnum === 'number' ? o.startAutnum : undefined;
  const end = typeof o.endAutnum === 'number' ? o.endAutnum : start;
  return {
    type: 'autnum',
    rir: ctx.rir,
    handle: clean(o.handle, 64) ?? 'UNKNOWN',
    asnStart: start,
    asnEnd: end,
    name: clean(o.name),
    country: clean(o.country, 3),
    status: strings(o.status),
    holder,
    abuse: abuseParty(ents, holder),
    tech: partyFor(ents, 'technical'),
    admin: partyFor(ents, 'administrative'),
    registered: eventDate(o, 'registration'),
    changed: eventDate(o, 'last changed'),
  };
}
```

`packages/core/src/reduce/entity.ts`:
```ts
import { clean } from './sanitize';
import type { EntityRecord, PersonalEntity, ReduceCtx } from './types';
import { asObject, eventDate, strings } from './util';
import { entityKind, isPersonLike, vcardValue, vcardValues } from './vcard';

export function reduceEntity(raw: unknown, ctx: ReduceCtx): EntityRecord | PersonalEntity {
  const o = asObject(raw);
  if (isPersonLike(o)) return { type: 'personal-entity', rir: ctx.rir };
  return {
    type: 'entity',
    rir: ctx.rir,
    handle: clean(o.handle, 64) ?? 'UNKNOWN',
    kind: entityKind(o) === 'group' ? 'group' : 'org',
    name: clean(vcardValue(o, 'fn')),
    email: clean(vcardValues(o, 'email')[0], 254),
    roles: strings(o.roles),
    registered: eventDate(o, 'registration'),
    changed: eventDate(o, 'last changed'),
  };
}
```

`packages/core/src/reduce/domain.ts`:
```ts
import { clean } from './sanitize';
import type { DomainRecord, ReduceCtx } from './types';
import { asObject, eventDate } from './util';

const dnsName = (v: unknown): string | undefined => clean(v, 253)?.toLowerCase().replace(/\.$/, '');

export function reduceDomain(raw: unknown, ctx: ReduceCtx): DomainRecord {
  const o = asObject(raw);
  const nameservers = (Array.isArray(o.nameservers) ? o.nameservers : []).flatMap((n) => {
    const name = dnsName(asObject(n).ldhName);
    return name ? [name] : [];
  });
  const sec = asObject(o.secureDNS);
  return {
    type: 'domain',
    rir: ctx.rir,
    zone: dnsName(o.ldhName) ?? '',
    nameservers,
    signed: sec.delegationSigned === true || (Array.isArray(sec.dsData) && sec.dsData.length > 0),
    registered: eventDate(o, 'registration'),
    changed: eventDate(o, 'last changed'),
  };
}
```

- [ ] **Step 5: Run tests, review snapshots, typecheck**

Run: `pnpm vitest run packages/core/test/reduce && pnpm typecheck`
Expected: PASS; vitest writes `packages/core/test/reduce/__snapshots__/fixtures.test.ts.snap`.
Open the snapshot file and confirm by eye: every record has a non-empty `prefixes` (for `ip`), no email outside org/group contacts, and `holder` is never a person's name. If a specific assertion fails because live data changed since this plan was written (e.g. a renamed network), update that one assertion to the recorded value and note it in the commit body.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): reduce RDAP records to PII-free compact form

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Answer types and text renderer

**Files:**
- Create: `packages/core/src/service/answer.ts`, `packages/core/src/render/format.ts`, `packages/core/src/render/text.ts`
- Test: `packages/core/test/render/text.test.ts`

**Interfaces:**
- Consumes: record types (Task 8); `SpecialUse` (Task 3); `RIR_LABEL`, `Rir` (Task 2); `reduceFixture` pattern and fixture helpers (Tasks 7–8).
- Produces:
  - `interface Meta { rir: Rir; cache: 'miss' | 'hit' | 'stale'; ageS: number; url: string }`
  - `type ErrorCode = 'invalid_input' | 'not_found' | 'not_delegated' | 'rate_limited' | 'upstream' | 'history_unavailable' | 'personal_record' | 'too_large'`
  - `type Answer<T> = { kind: 'record'; record: T; meta: Meta } | { kind: 'special'; query: string; special: SpecialUse } | { kind: 'error'; code: ErrorCode; message: string; retryAfterS?: number }`
  - `lines(rows: Array<[string, string | undefined]>): string` (key column min width 10); `age(s): string`; `sourceText(meta): string`; `datesText(registered?, changed?)`; `holderText(p?)`; `contactText(p?, url?)`
  - `renderNetwork(r: NetworkRecord, meta: Meta): string`, `renderAutnum`, `renderEntity(r: EntityRecord, meta)`, `renderDomain`, `renderSpecial(query: string, s: SpecialUse): string`

- [ ] **Step 1: Write the failing test**

`packages/core/test/render/text.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { reduceAutnum } from '../../src/reduce/autnum';
import { reduceDomain } from '../../src/reduce/domain';
import { reduceEntity } from '../../src/reduce/entity';
import { reduceNetwork } from '../../src/reduce/network';
import type { EntityRecord, NetworkRecord } from '../../src/reduce/types';
import { renderAutnum, renderDomain, renderEntity, renderNetwork, renderSpecial } from '../../src/render/text';
import type { Meta } from '../../src/service/answer';
import { loadFixture, rdapFixtures, rirOf } from '../support/fixtures';

const URL_A = 'https://rdap.apnic.net/ip/1.1.1.1';
const meta = (cache: Meta['cache'] = 'miss', ageS = 0): Meta => ({ rir: 'apnic', cache, ageS, url: URL_A });

const net: NetworkRecord = {
  type: 'network', rir: 'apnic', handle: '1.1.1.0 - 1.1.1.255', prefixes: ['1.1.1.0/24'], name: 'APNIC-LABS',
  country: 'AU', allocationType: 'ASSIGNED PORTABLE', status: ['active'],
  holder: { handle: 'ORG-ARAD1-AP', name: 'APNIC Research and Development', email: 'helpdesk@apnic.net' },
  abuse: { handle: 'IRT-APNICRANDNET-AU', name: 'IRT-APNICRANDNET-AU', email: 'helpdesk@apnic.net' },
  tech: { handle: 'AIC3-AP', name: 'APNICRANDNET Infrastructure Contact', email: 'research@apnic.net' },
  registered: '2011-08-10', changed: '2023-04-26',
};

describe('renderNetwork', () => {
  it('renders the spec example exactly', () => {
    expect(renderNetwork(net, meta())).toBe([
      'network   1.1.1.0/24  APNIC-LABS  (AU, ASSIGNED PORTABLE, active)',
      'holder    APNIC Research and Development  [ORG-ARAD1-AP]',
      'abuse     helpdesk@apnic.net  [IRT-APNICRANDNET-AU]',
      'tech      research@apnic.net  [AIC3-AP]',
      'dates     registered 2011-08-10, changed 2023-04-26',
      'source    APNIC RDAP, fetched just now',
    ].join('\n'));
  });

  it('never names a personal abuse contact and points to the network record', () => {
    const text = renderNetwork({ ...net, rir: 'lacnic', abuse: { personal: true }, tech: { personal: true } }, { ...meta(), rir: 'lacnic' });
    expect(text).toContain(`abuse     personal contact, not disclosed; see ${URL_A}`);
    expect(text).toContain('tech      personal contact, not disclosed');
    expect(text).toContain('source    LACNIC RDAP');
  });

  it('labels cache age and staleness', () => {
    expect(renderNetwork(net, meta('hit', 180))).toContain('source    APNIC RDAP, cached 3m ago');
    expect(renderNetwork(net, meta('stale', 3 * 3600))).toContain('STALE: fetched 3h ago');
  });
});

describe('other renderers', () => {
  it('renders entity, domain and special answers', () => {
    const ent: EntityRecord = { type: 'entity', rir: 'apnic', handle: 'ORG-ARAD1-AP', kind: 'org', name: 'APNIC Research and Development', email: 'helpdesk@apnic.net', roles: [] };
    expect(renderEntity(ent, meta())).toContain('entity    APNIC Research and Development  [ORG-ARAD1-AP]  (org)');
    const dom = renderDomain({ type: 'domain', rir: 'apnic', zone: '1.1.1.in-addr.arpa', nameservers: ['a.example', 'b.example'], signed: false }, meta());
    expect(dom).toContain('zone      1.1.1.in-addr.arpa');
    expect(dom).toContain('nameservers a.example, b.example');
    expect(dom).toContain('dnssec    not signed (no DS in registry)');
    expect(renderSpecial('10.1.2.3', { name: 'Private-Use', ref: 'RFC 1918' })).toContain('10.1.2.3  Private-Use (RFC 1918)');
  });
});

describe('token budget: every current-record fixture renders under 600 bytes', () => {
  const reducers = { ip: [reduceNetwork, renderNetwork], autnum: [reduceAutnum, renderAutnum], entity: [reduceEntity, renderEntity], domain: [reduceDomain, renderDomain] } as const;
  it.each(rdapFixtures(Object.keys(reducers)))('%s', (rel) => {
    const kind = rel.split('/')[2] as keyof typeof reducers;
    const [reduce, render] = reducers[kind];
    const record = reduce(loadFixture(rel), { rir: rirOf(rel) });
    if (record.type === 'personal-entity') return;
    const text = (render as (r: unknown, m: Meta) => string)(record, { ...meta(), rir: rirOf(rel) });
    expect(new TextEncoder().encode(text).length).toBeLessThan(600);
    expect(text).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/render/text.test.ts`
Expected: FAIL — cannot resolve `../../src/render/text`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/service/answer.ts`:
```ts
import type { Rir } from '../rdap/rirs';
import type { SpecialUse } from '../special-use';

export interface Meta {
  readonly rir: Rir;
  readonly cache: 'miss' | 'hit' | 'stale';
  readonly ageS: number;
  /** The RDAP URL this answer came from; used as the "see" pointer for undisclosed contacts. */
  readonly url: string;
}

export type ErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'not_delegated'
  | 'rate_limited'
  | 'upstream'
  | 'history_unavailable'
  | 'personal_record'
  | 'too_large';

export type Answer<T> =
  | { readonly kind: 'record'; readonly record: T; readonly meta: Meta }
  | { readonly kind: 'special'; readonly query: string; readonly special: SpecialUse }
  | { readonly kind: 'error'; readonly code: ErrorCode; readonly message: string; readonly retryAfterS?: number };
```

`packages/core/src/render/format.ts`:
```ts
import { RIR_LABEL } from '../rdap/rirs';
import { isPersonal, type Party } from '../reduce/types';
import type { Meta } from '../service/answer';

/** Aligned "key  value" lines; rows with no value are dropped. */
export function lines(rows: ReadonlyArray<readonly [string, string | undefined]>): string {
  return rows
    .filter((r): r is readonly [string, string] => Boolean(r[1]))
    .map(([k, v]) => `${k.padEnd(Math.max(10, k.length + 1))}${v}`)
    .join('\n');
}

export function age(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export function sourceText(meta: Meta): string {
  const label = RIR_LABEL[meta.rir];
  if (meta.cache === 'miss') return `${label} RDAP, fetched just now`;
  if (meta.cache === 'hit') return `${label} RDAP, cached ${age(meta.ageS)} ago`;
  return `${label} RDAP, STALE: fetched ${age(meta.ageS)} ago; ${label} RDAP is unreachable now`;
}

export function datesText(registered?: string, changed?: string): string | undefined {
  const parts = [registered && `registered ${registered}`, changed && `changed ${changed}`].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export function holderText(p: Party | undefined): string | undefined {
  if (!p) return undefined;
  if (isPersonal(p)) return 'private individual (not disclosed)';
  return `${p.name ?? p.handle}  [${p.handle}]`;
}

/** `pointer` (the record's RDAP URL) is shown for undisclosed abuse contacts so users can follow up. */
export function contactText(p: Party | undefined, pointer?: string): string | undefined {
  if (!p) return undefined;
  if (isPersonal(p)) return pointer ? `personal contact, not disclosed; see ${pointer}` : 'personal contact, not disclosed';
  return `${p.email ?? p.name ?? p.handle}  [${p.handle}]`;
}

export function details(...parts: ReadonlyArray<string | undefined>): string {
  const d = parts.filter(Boolean).join(', ');
  return d ? `  (${d})` : '';
}
```

`packages/core/src/render/text.ts`:
```ts
import type { AutnumRecord, DomainRecord, EntityRecord, NetworkRecord } from '../reduce/types';
import type { SpecialUse } from '../special-use';
import type { Meta } from '../service/answer';
import { contactText, datesText, details, holderText, lines, sourceText } from './format';

export function renderNetwork(r: NetworkRecord, meta: Meta): string {
  const head = [r.prefixes.join(' ') || r.handle, r.name].filter(Boolean).join('  ');
  return lines([
    ['network', head + details(r.country, r.allocationType, ...r.status)],
    ['holder', holderText(r.holder)],
    ['abuse', contactText(r.abuse, meta.url)],
    ['tech', contactText(r.tech)],
    ['dates', datesText(r.registered, r.changed)],
    ['source', sourceText(meta)],
  ]);
}

export function renderAutnum(r: AutnumRecord, meta: Meta): string {
  const asn = r.asnStart === undefined ? r.handle
    : r.asnEnd !== undefined && r.asnEnd !== r.asnStart ? `AS${r.asnStart}-AS${r.asnEnd}` : `AS${r.asnStart}`;
  return lines([
    ['asn', [asn, r.name].filter(Boolean).join('  ') + details(r.country, ...r.status)],
    ['holder', holderText(r.holder)],
    ['abuse', contactText(r.abuse, meta.url)],
    ['tech', contactText(r.tech)],
    ['dates', datesText(r.registered, r.changed)],
    ['source', sourceText(meta)],
  ]);
}

export function renderEntity(r: EntityRecord, meta: Meta): string {
  return lines([
    ['entity', `${r.name ?? r.handle}  [${r.handle}]  (${r.kind})`],
    ['email', r.email],
    ['roles', r.roles.length > 0 ? r.roles.join(', ') : undefined],
    ['dates', datesText(r.registered, r.changed)],
    ['source', sourceText(meta)],
  ]);
}

export function renderDomain(r: DomainRecord, meta: Meta): string {
  return lines([
    ['zone', r.zone],
    ['nameservers', r.nameservers.length > 0 ? r.nameservers.join(', ') : 'none registered'],
    ['dnssec', r.signed ? 'signed' : 'not signed (no DS in registry)'],
    ['dates', datesText(r.registered, r.changed)],
    ['source', sourceText(meta)],
  ]);
}

export function renderSpecial(query: string, s: SpecialUse): string {
  return `${query}  ${s.name} (${s.ref}): IANA special-purpose space, not registered to any organisation. No RDAP lookup was made.`;
}
```

- [ ] **Step 4: Run tests, review snapshots, typecheck**

Run: `pnpm vitest run packages/core/test/render && pnpm typecheck`
Expected: PASS. Open `packages/core/test/render/__snapshots__/text.test.ts.snap`: the LACNIC and AFRINIC renderings must show `personal contact, not disclosed` and no person names.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): render compact text answers within the token budget

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: History (whowas) reduction and rendering

**Files:**
- Create: `packages/core/src/reduce/history.ts`, `packages/core/src/render/history.ts`
- Test: `packages/core/test/reduce/history.test.ts`

**Interfaces:**
- Consumes: `prefixesOf` (Task 8), `flattenEntities`, `partyFor`, `clean`, `asObject`, `strings`, `Obj`, vcard helpers (Tasks 7–8), `parseIpOrCidr` (Task 1), `RdapError` (Task 5), `Rir`, `RIR_LABEL` (Task 2), `Meta`, `lines`, `sourceText`, `details` (Task 9).
- Produces:
  - `type Detail = 'summary' | 'full'`
  - `interface StateSummary { name?; status?; country?; type?; nameservers?; holder?; holderName?; abuse?; tech?; admin? }` (all strings; person-held roles are `'personal'`)
  - `interface StateRow { from: string; until?: string; s: StateSummary | null }` (dates YYYY-MM-DD; `s: null` = withdrawn)
  - `interface ObjectHistory { key: string; prefixLength: number; states: readonly StateRow[] }` (`prefixLength` −1 for non-IP)
  - `interface HistoryRecord { type: 'history'; rir: Rir; query: string; rawRecords: number; latestFrom?: string; objects: readonly ObjectHistory[] }` (objects sorted most specific first)
  - `interface Change { date: string; kind: 'created' | 'withdrawn' | 're-created' | 'changed'; fields: StateSummary }`
  - `reduceHistory(raw: unknown, ctx: { rir: Rir; query: string }): HistoryRecord` (throws `RdapError('bad_response')` without a `records` array)
  - `historyChanges(obj: ObjectHistory, detail: Detail, since?: string): Change[]`
  - `stateAt(rec: HistoryRecord, date: string): { object: ObjectHistory; row: StateRow } | null`
  - `interface HistoryViewOpts { detail: Detail; since?: string; at?: string }`; `renderHistory(rec: HistoryRecord, meta: Meta, opts: HistoryViewOpts): string`

- [ ] **Step 1: Write the failing test**

`packages/core/test/reduce/history.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { historyChanges, reduceHistory, stateAt } from '../../src/reduce/history';
import { renderHistory } from '../../src/render/history';
import type { Meta } from '../../src/service/answer';
import { loadFixture } from '../support/fixtures';

const meta: Meta = { rir: 'apnic', cache: 'miss', ageS: 0, url: 'https://rdap.apnic.net/history/ip/192.0.2.1' };
const vc = (kind: string, fn: string) => ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', fn], ['kind', {}, 'text', kind]]];
const live = { status: ['active'], country: 'AU', type: 'ASSIGNED PORTABLE' };
const rec = (from: string, until: string | null, content: Record<string, unknown>, cidr = { v4prefix: '192.0.2.0', length: 24 }) => ({
  applicableFrom: `${from}T00:00:00Z`,
  applicableUntil: until ? `${until}T00:00:00Z` : null,
  content: { objectClassName: 'ip network', handle: 'H', cidr0_cidrs: [cidr], ...content },
});

const synthetic = {
  records: [
    rec('2010-01-01', '2011-01-01', { name: 'ALPHA', ...live }),
    rec('2011-01-01', '2011-06-01', { name: 'ALPHA', ...live, remarks: [{ description: ['edit'] }] }),
    rec('2011-06-01', '2011-06-02', {}),
    rec('2011-06-02', '2014-01-01', { name: 'ALPHA', ...live }),
    rec('2014-01-01', '2017-01-01', { name: 'BETA', ...live, entities: [{ handle: 'P-9', roles: ['technical'], vcardArray: vc('individual', 'Jane Doe') }] }),
    rec('2017-01-01', null, { name: 'BETA', ...live, entities: [{ handle: 'ORG-X-AP', roles: ['registrant'], vcardArray: vc('org', 'Example Org') }] }),
    rec('2009-01-01', null, { name: 'COVER', ...live }, { v4prefix: '192.0.0.0', length: 16 }),
  ],
};

describe('reduceHistory (synthetic)', () => {
  const h = reduceHistory(synthetic, { rir: 'apnic', query: '192.0.2.1' });

  it('groups by object, most specific first, and collapses identical states', () => {
    expect(h.objects.map((o) => o.key)).toEqual(['192.0.2.0/24', '192.0.0.0/16']);
    expect(h.objects[0]?.states[0]).toEqual({ from: '2010-01-01', until: '2011-06-01', s: expect.objectContaining({ name: 'ALPHA' }) });
    expect(h.rawRecords).toBe(7);
    expect(h.latestFrom).toBe('2017-01-01');
    expect(JSON.stringify(h)).not.toContain('Jane');
  });

  it('derives summary changes including withdrawal and re-creation', () => {
    const primary = h.objects[0]!;
    expect(historyChanges(primary, 'summary').map((c) => [c.date, c.kind])).toEqual([
      ['2010-01-01', 'created'], ['2011-06-01', 'withdrawn'], ['2011-06-02', 're-created'],
      ['2014-01-01', 'changed'], ['2017-01-01', 'changed'],
    ]);
    expect(historyChanges(primary, 'summary', '2014-01-01')).toHaveLength(2);
    expect(historyChanges(primary, 'full')[3]?.fields).toEqual({ name: 'BETA', tech: 'personal' });
  });

  it('answers point-in-time queries, falling back to covering objects', () => {
    expect(stateAt(h, '2012-01-01')?.row.s?.name).toBe('ALPHA');
    expect(stateAt(h, '2011-06-01')?.row.s).toBeNull();
    expect(stateAt(h, '2009-06-01')?.object.key).toBe('192.0.0.0/16');
    expect(stateAt(h, '2000-01-01')).toBeNull();
  });

  it('renders the summary timeline', () => {
    expect(renderHistory(h, meta, { detail: 'summary' })).toBe([
      '192.0.2.0/24  history (APNIC RDAP, 7 records -> 5 changes)',
      '2010-01-01  created    ALPHA  ASSIGNED PORTABLE  AU  active',
      '2011-06-01  withdrawn',
      '2011-06-02  re-created ALPHA  ASSIGNED PORTABLE  AU  active',
      '2014-01-01  renamed    BETA',
      '2017-01-01  holder     ORG-X-AP (Example Org)',
      'covering    192.0.0.0/16 COVER (since 2009-01-01)',
      'source    APNIC RDAP, fetched just now',
    ].join('\n'));
  });

  it('renders a point-in-time answer', () => {
    const text = renderHistory(h, meta, { detail: 'summary', at: '2012-01-01' });
    expect(text).toContain('192.0.2.1 on 2012-01-01');
    expect(text).toContain('object    192.0.2.0/24  ALPHA');
    expect(text).toContain('valid     2011-06-02 .. 2014-01-01');
  });

  it('rejects responses without records', () => {
    expect(() => reduceHistory({}, { rir: 'apnic', query: 'x' })).toThrow('records');
  });
});

describe('reduceHistory (recorded APNIC fixtures)', () => {
  it('1.1.1.1: provenance of 1.1.1.0/24', () => {
    const h = reduceHistory(loadFixture('rdap/apnic/history-ip/1.1.1.1.json'), { rir: 'apnic', query: '1.1.1.1' });
    const primary = h.objects[0]!;
    expect(primary.key).toBe('1.1.1.0/24');
    const changes = historyChanges(primary, 'summary');
    expect(changes.slice(0, 3).map((c) => c.kind)).toEqual(['created', 'withdrawn', 're-created']);
    expect(changes).toContainEqual(expect.objectContaining({ date: '2014-05-07', fields: expect.objectContaining({ name: 'APNIC-LABS' }) }));
    expect(changes).toContainEqual(expect.objectContaining({ date: '2017-08-29', fields: expect.objectContaining({ holder: 'ORG-ARAD1-AP' }) }));
    expect(h.objects.map((o) => o.key)).toContain('1.0.0.0/8');
    expect(stateAt(h, '2012-01-01')?.row.s?.name).toBe('Debogon-prefix');
    const text = renderHistory(h, { ...meta, url: 'https://rdap.apnic.net/history/ip/1.1.1.1' }, { detail: 'summary' });
    expect(new TextEncoder().encode(text).length).toBeLessThan(1500);
    for (const marker of ['Example Person', 'example.net', '[scrubbed]']) expect(JSON.stringify(h) + text).not.toContain(marker);
    expect(text).toMatchSnapshot();
  });

  it('AS4608 renders under budget', () => {
    const h = reduceHistory(loadFixture('rdap/apnic/history-autnum/4608.json'), { rir: 'apnic', query: 'AS4608' });
    expect(h.objects[0]?.key).toBe('AS4608');
    const text = renderHistory(h, meta, { detail: 'summary' });
    expect(new TextEncoder().encode(text).length).toBeLessThan(1500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/reduce/history.test.ts`
Expected: FAIL — cannot resolve `../../src/reduce/history`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/reduce/history.ts`:
```ts
import { parseIpOrCidr } from '../input/ip';
import { RdapError } from '../rdap/errors';
import type { Rir } from '../rdap/rirs';
import { flattenEntities, partyFor } from './entities';
import { prefixesOf } from './network';
import { clean } from './sanitize';
import { isPersonal, type Party } from './types';
import { asObject, strings, type Obj } from './util';
import { isPersonLike, vcardValue } from './vcard';

export type Detail = 'summary' | 'full';

export interface StateSummary {
  readonly name?: string;
  readonly status?: string;
  readonly country?: string;
  readonly type?: string;
  readonly nameservers?: string;
  readonly holder?: string;
  readonly holderName?: string;
  readonly abuse?: string;
  readonly tech?: string;
  readonly admin?: string;
}
type Field = keyof StateSummary;

export interface StateRow {
  readonly from: string;
  readonly until?: string;
  readonly s: StateSummary | null;
}

export interface ObjectHistory {
  readonly key: string;
  readonly prefixLength: number;
  readonly states: readonly StateRow[];
}

export interface HistoryRecord {
  readonly type: 'history';
  readonly rir: Rir;
  readonly query: string;
  readonly rawRecords: number;
  readonly latestFrom?: string;
  readonly objects: readonly ObjectHistory[];
}

export interface Change {
  readonly date: string;
  readonly kind: 'created' | 'withdrawn' | 're-created' | 'changed';
  readonly fields: StateSummary;
}

export const SUMMARY_FIELDS: readonly Field[] = ['name', 'status', 'country', 'type', 'nameservers', 'holder', 'holderName'];
export const FULL_FIELDS: readonly Field[] = [...SUMMARY_FIELDS, 'abuse', 'tech', 'admin'];

const dateOnly = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;

const partyKey = (p: Party | undefined): string | undefined => (!p ? undefined : isPersonal(p) ? 'personal' : p.handle);

/** A record with none of these is a withdrawal marker (it keeps only handle/range). */
function isTombstone(c: Obj): boolean {
  return c.name === undefined && c.status === undefined && c.vcardArray === undefined && c.nameservers === undefined;
}

function summarise(c: Obj): StateSummary | null {
  if (isTombstone(c)) return null;
  const ents = flattenEntities(c);
  const holder = partyFor(ents, 'registrant');
  const isEntity = c.objectClassName === 'entity';
  const ns = Array.isArray(c.nameservers)
    ? c.nameservers.flatMap((n) => { const x = clean(asObject(n).ldhName, 253); return x ? [x.toLowerCase().replace(/\.$/, '')] : []; })
    : [];
  const s: Partial<Record<Field, string>> = {
    name: isEntity ? (isPersonLike(c) ? undefined : clean(vcardValue(c, 'fn'))) : clean(c.name),
    status: strings(c.status).join(', ') || undefined,
    country: clean(c.country, 3),
    type: clean(c.type, 40),
    nameservers: ns.join(', ') || undefined,
    holder: partyKey(holder),
    holderName: holder && !isPersonal(holder) ? holder.name : undefined,
    abuse: partyKey(partyFor(ents, 'abuse')),
    tech: partyKey(partyFor(ents, 'technical')),
    admin: partyKey(partyFor(ents, 'administrative')),
  };
  for (const k of Object.keys(s) as Field[]) if (s[k] === undefined) delete s[k];
  return s;
}

function keyOf(c: Obj): { key: string; prefixLength: number } | null {
  if (c.objectClassName === 'ip network') {
    const prefixes = prefixesOf(c);
    const first = prefixes[0];
    return first ? { key: prefixes.join(' '), prefixLength: parseIpOrCidr(first).length } : null;
  }
  if (c.objectClassName === 'autnum' && typeof c.startAutnum === 'number') {
    const end = typeof c.endAutnum === 'number' && c.endAutnum !== c.startAutnum ? `-AS${c.endAutnum}` : '';
    return { key: `AS${c.startAutnum}${end}`, prefixLength: -1 };
  }
  if (c.objectClassName === 'domain' && typeof c.ldhName === 'string') {
    return { key: c.ldhName.toLowerCase().replace(/\.$/, ''), prefixLength: -1 };
  }
  const handle = clean(c.handle, 64);
  return handle ? { key: handle, prefixLength: -1 } : null;
}

function same(a: StateSummary | null, b: StateSummary | null, fields: readonly Field[] = FULL_FIELDS): boolean {
  if (a === null || b === null) return a === b;
  return fields.every((f) => a[f] === b[f]);
}

export function reduceHistory(raw: unknown, ctx: { rir: Rir; query: string }): HistoryRecord {
  const o = asObject(raw);
  if (!Array.isArray(o.records)) throw new RdapError('bad_response', 'History response has no records array');
  const groups = new Map<string, { prefixLength: number; rows: Array<StateRow & { ts: string }> }>();
  for (const item of o.records) {
    const r = asObject(item);
    const c = asObject(r.content);
    const from = dateOnly(r.applicableFrom);
    const k = keyOf(c);
    if (!from || !k || typeof r.applicableFrom !== 'string') continue;
    const g = groups.get(k.key) ?? { prefixLength: k.prefixLength, rows: [] };
    g.rows.push({ ts: r.applicableFrom, from, until: dateOnly(r.applicableUntil), s: summarise(c) });
    groups.set(k.key, g);
  }
  const objects: ObjectHistory[] = [...groups.entries()]
    .map(([key, g]) => {
      const sorted = g.rows.sort((a, b) => a.ts.localeCompare(b.ts));
      const states: StateRow[] = [];
      for (const { from, until, s } of sorted) {
        const last = states.at(-1);
        if (last && same(last.s, s)) states[states.length - 1] = { ...last, until };
        else states.push({ from, until, s });
      }
      return { key, prefixLength: g.prefixLength, states };
    })
    .sort((a, b) => b.prefixLength - a.prefixLength);
  const latestFrom = objects.flatMap((x) => x.states.map((s) => s.from)).sort().at(-1);
  return { type: 'history', rir: ctx.rir, query: ctx.query, rawRecords: o.records.length, latestFrom, objects };
}

function pick(s: StateSummary, fields: readonly Field[]): StateSummary {
  const out: Partial<Record<Field, string>> = {};
  for (const f of fields) if (s[f] !== undefined) out[f] = s[f];
  return out;
}

function diff(prev: StateSummary, cur: StateSummary, fields: readonly Field[]): StateSummary {
  const out: Partial<Record<Field, string>> = {};
  for (const f of fields) if (prev[f] !== cur[f]) out[f] = cur[f] ?? '(none)';
  return out;
}

export function historyChanges(obj: ObjectHistory, detail: Detail, since?: string): Change[] {
  const fields = detail === 'full' ? FULL_FIELDS : SUMMARY_FIELDS;
  const out: Change[] = [];
  let prev: StateSummary | null | undefined;
  let alive = false;
  let everAlive = false;
  for (const row of obj.states) {
    const cur = row.s ? pick(row.s, fields) : null;
    if (prev !== undefined && same(prev, cur, fields)) continue;
    if (cur === null) {
      if (alive) out.push({ date: row.from, kind: 'withdrawn', fields: {} });
      alive = false;
    } else if (!alive || prev == null) {
      out.push({ date: row.from, kind: everAlive ? 're-created' : 'created', fields: cur });
      alive = true;
      everAlive = true;
    } else {
      out.push({ date: row.from, kind: 'changed', fields: diff(prev, cur, fields) });
    }
    prev = cur;
  }
  return since ? out.filter((c) => c.date >= since) : out;
}

/** The registration state on a date: the most specific object first, then covering objects. */
export function stateAt(rec: HistoryRecord, date: string): { object: ObjectHistory; row: StateRow } | null {
  for (const object of rec.objects) {
    const row = object.states.find((r) => r.from <= date && (r.until === undefined || date < r.until));
    if (row) return { object, row };
  }
  return null;
}
```

`packages/core/src/render/history.ts`:
```ts
import { RIR_LABEL } from '../rdap/rirs';
import { historyChanges, stateAt, type Change, type Detail, type HistoryRecord, type ObjectHistory, type StateSummary } from '../reduce/history';
import type { Meta } from '../service/answer';
import { details, lines, sourceText } from './format';

export interface HistoryViewOpts {
  readonly detail: Detail;
  readonly since?: string;
  readonly at?: string;
}

const MAX_CHANGES = 20;
const row = (date: string, label: string, text: string): string => `${date}  ${label.padEnd(11)}${text}`.trimEnd();
const holderLabel = (f: StateSummary): string =>
  f.holder === 'personal' ? 'private individual' : `${f.holder ?? '(none)'}${f.holderName ? ` (${f.holderName})` : ''}`;
const describe = (f: StateSummary): string =>
  [f.name, f.type, f.country, f.status, f.nameservers, f.holder ? `holder ${holderLabel(f)}` : undefined].filter(Boolean).join('  ');

function changeLine(c: Change): string {
  if (c.kind === 'withdrawn') return `${c.date}  withdrawn`;
  if (c.kind !== 'changed') return row(c.date, c.kind, describe(c.fields));
  const keys = Object.keys(c.fields) as Array<keyof StateSummary>;
  if (keys.length === 1 && keys[0] === 'name') return row(c.date, 'renamed', c.fields.name ?? '(none)');
  if (keys.every((k) => k === 'holder' || k === 'holderName')) return row(c.date, 'holder', holderLabel(c.fields));
  return row(c.date, 'changed', keys.map((k) => `${k}=${c.fields[k]}`).join('; '));
}

function coveringLine(o: ObjectHistory): string | null {
  const current = o.states.at(-1);
  if (o.prefixLength <= 0 || !current?.s) return null;
  let since = current.from;
  for (let i = o.states.length - 2; i >= 0; i--) {
    const s = o.states[i]?.s;
    if (!s || s.name !== current.s.name) break;
    since = o.states[i]?.from ?? since;
  }
  return `${'covering'.padEnd(12)}${o.key} ${current.s.name ?? ''} (since ${since})`;
}

function renderAt(rec: HistoryRecord, meta: Meta, at: string): string {
  const header = `${rec.query} on ${at} (${RIR_LABEL[rec.rir]} RDAP history)`;
  const hit = stateAt(rec, at);
  if (!hit) return `${header}\nno registration record covers that date\n${lines([['source', sourceText(meta)]])}`;
  const s = hit.row.s;
  return `${header}\n${lines([
    ['object', s ? `${hit.object.key}  ${s.name ?? ''}`.trimEnd() + details(s.country, s.type, s.status) : `${hit.object.key}  withdrawn`],
    ['holder', s?.holder ? holderLabel(s) : undefined],
    ['valid', `${hit.row.from} .. ${hit.row.until ?? 'now'}`],
    ['source', sourceText(meta)],
  ])}`;
}

export function renderHistory(rec: HistoryRecord, meta: Meta, opts: HistoryViewOpts): string {
  if (opts.at) return renderAt(rec, meta, opts.at);
  const [primary, ...others] = rec.objects;
  if (!primary) return `${rec.query}  no registration history found\n${lines([['source', sourceText(meta)]])}`;
  const changes = historyChanges(primary, opts.detail, opts.since);
  const shown = changes.slice(-MAX_CHANGES);
  const out = [
    `${primary.key}  history (${RIR_LABEL[rec.rir]} RDAP, ${rec.rawRecords} records -> ${changes.length} changes${opts.since ? ` since ${opts.since}` : ''})`,
  ];
  if (shown.length < changes.length) out.push(`... ${changes.length - shown.length} earlier changes omitted; narrow with since=YYYY-MM-DD`);
  out.push(...shown.map(changeLine));
  for (const o of others) {
    const line = coveringLine(o);
    if (line) out.push(line);
  }
  out.push(lines([['source', sourceText(meta)]]));
  return out.join('\n');
}
```

- [ ] **Step 4: Run tests, review snapshot, typecheck**

Run: `pnpm vitest run packages/core/test/reduce/history.test.ts && pnpm typecheck`
Expected: PASS. Open the new snapshot: the 1.1.1.1 timeline should read created → withdrawn → re-created → renamed APNIC-LABS → holder ORG-ARAD1-AP, then a `covering 1.0.0.0/8 APNIC-AP` line. If a fixture-specific assertion fails only because APNIC added records after this plan was written, update that one assertion to the recorded data and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): reduce APNIC whowas history to provenance timelines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: RirService pipeline

**Files:**
- Create: `packages/core/src/service/fetcher.ts`, `packages/core/src/service/service.ts`
- Test: `packages/core/test/service/service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces:
  - `TTL_S = { current: 3600, currentStale: 86_400, notFound: 900, history: 604_800, historyStale: 2_592_000 }`, `WEIGHT = { current: 1, history: 5 }`
  - `type Stored<T> = { found: true; value: T } | { found: false }`; `type FetchOutcome<T>`; `interface FetchRequest<T> { key; rir; url; weight; freshS; staleS; maxBytes; reduce: (raw: unknown) => T; force?: boolean }`; `class CachedFetcher { get<T>(req): Promise<FetchOutcome<T>>; peek<T>(key): Promise<CacheEntry<Stored<T>> | null> }`
  - `interface ServiceDeps { fetch: FetchLike; cache: CacheStore; limiter: RateLimiter; clock: Clock; userAgent: string; timeoutMs?: number }`
  - `type HistoryType = 'ip' | 'asn' | 'entity' | 'reverse_dns'`; `interface HistoryRequest { resource: string; type?: HistoryType; rir?: Rir }`; `inferHistoryType(resource: string): HistoryType`
  - `class RirService` with `ip(input: string): Promise<Answer<NetworkRecord>>`, `asn(input: string | number): Promise<Answer<AutnumRecord>>`, `entity(handle: string, rir?: Rir): Promise<Answer<EntityRecord>>`, `reverseDns(input: string): Promise<Answer<DomainRecord>>`, `history(req: HistoryRequest): Promise<Answer<HistoryRecord>>`

- [ ] **Step 1: Write the failing test**

`packages/core/test/service/service.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../src/memory/cache';
import { MemoryRateLimiter } from '../../src/memory/rate-limiter';
import type { RateLimiter } from '../../src/ports';
import { DEFAULT_LIMITS } from '../../src/rdap/limits';
import { RirService } from '../../src/service/service';
import { FakeClock } from '../support/fake-clock';
import { fakeFetch, type FakeRoute } from '../support/fake-fetch';
import { ianaRoutes, loadFixture } from '../support/fixtures';

const APNIC = 'https://rdap.apnic.net/';
const IP_URL = `${APNIC}ip/1.1.1.1`;
const HIST_URL = `${APNIC}history/ip/1.1.1.1`;
const HOUR = 3_600_000;

function setup(routes: Record<string, FakeRoute | (() => FakeRoute)> = {}, limiter?: RateLimiter) {
  const fetch = fakeFetch({
    ...ianaRoutes(),
    [IP_URL]: { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
    [HIST_URL]: { body: loadFixture('rdap/apnic/history-ip/1.1.1.1.json') },
    [`${APNIC}autnum/4608`]: { body: loadFixture('rdap/apnic/autnum/4608.json') },
    [`${APNIC}entity/ORG-ARAD1-AP`]: { body: loadFixture('rdap/apnic/entity/ORG-ARAD1-AP.json') },
    [`${APNIC}domain/1.1.1.in-addr.arpa`]: { body: loadFixture('rdap/apnic/domain/1.1.1.in-addr.arpa.json') },
    ...routes,
  });
  const clock = new FakeClock();
  const service = new RirService({
    fetch, clock, userAgent: 'test', cache: new MemoryCache(clock),
    limiter: limiter ?? new MemoryRateLimiter(DEFAULT_LIMITS, clock),
  });
  const rdapCalls = () => fetch.calls.filter((u) => !u.startsWith('https://data.iana.org/'));
  return { fetch, clock, service, rdapCalls };
}

describe('RirService.ip', () => {
  it('fetches once, then serves from cache', async () => {
    const { service, rdapCalls } = setup();
    const a = await service.ip('1.1.1.1');
    expect(a).toMatchObject({ kind: 'record', record: { prefixes: ['1.1.1.0/24'] }, meta: { rir: 'apnic', cache: 'miss', url: IP_URL } });
    expect(await service.ip(' 1.1.1.1 ')).toMatchObject({ kind: 'record', meta: { cache: 'hit' } });
    expect(rdapCalls()).toEqual([IP_URL]);
  });

  it('answers special-purpose space with no network calls at all', async () => {
    const { service, fetch } = setup();
    expect(await service.ip('10.1.2.3')).toMatchObject({ kind: 'special', query: '10.1.2.3', special: { ref: 'RFC 1918' } });
    expect(await service.ip('203.0.113.5')).toMatchObject({ kind: 'special' });
    expect(fetch.calls).toEqual([]);
  });

  it('reports addresses outside every RIR delegation without an RDAP call', async () => {
    const { service, rdapCalls } = setup();
    expect(await service.ip('4000::1')).toMatchObject({ kind: 'error', code: 'not_delegated' });
    expect(rdapCalls()).toEqual([]);
  });

  it('returns invalid_input with an example for bad input', async () => {
    const { service } = setup();
    const a = await service.ip('1.1.1');
    expect(a).toMatchObject({ kind: 'error', code: 'invalid_input' });
    expect(a.kind === 'error' && a.message).toContain('e.g. 1.1.1.1');
  });

  it('caches not-found answers', async () => {
    const { service, rdapCalls } = setup();
    expect(await service.ip('1.1.2.3')).toMatchObject({ kind: 'error', code: 'not_found' });
    expect(await service.ip('1.1.2.3')).toMatchObject({ kind: 'error', code: 'not_found' });
    expect(rdapCalls()).toHaveLength(1);
  });

  it('serves a labelled stale answer when the RIR fails after expiry', async () => {
    let down = false;
    const { service, clock } = setup({ [IP_URL]: () => (down ? { status: 503, text: '' } : { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') }) });
    await service.ip('1.1.1.1');
    clock.advance(2 * HOUR);
    down = true;
    expect(await service.ip('1.1.1.1')).toMatchObject({ kind: 'record', meta: { cache: 'stale', ageS: 7200 } });
  });

  it('never caches an HTML challenge page', async () => {
    // Permissive limiter: the first failure penalises the real one, which would hide the second call.
    const open: RateLimiter = { acquire: async () => ({ ok: true }), penalise: async () => {} };
    const { service, rdapCalls } = setup({ [IP_URL]: { text: '<html>challenge</html>', headers: { 'content-type': 'text/html' } } }, open);
    expect(await service.ip('1.1.1.1')).toMatchObject({ kind: 'error', code: 'upstream' });
    await service.ip('1.1.1.1');
    expect(rdapCalls()).toEqual([IP_URL, IP_URL]);
  });

  it('coalesces a burst of identical questions into one upstream call', async () => {
    const { service, rdapCalls } = setup();
    const answers = await Promise.all(Array.from({ length: 5 }, () => service.ip('1.1.1.1')));
    expect(answers.every((a) => a.kind === 'record')).toBe(true);
    expect(rdapCalls()).toEqual([IP_URL]);
  });

  it('serves stale when the local limiter is exhausted, else reports retry time', async () => {
    let allow = true;
    const limiter: RateLimiter = {
      acquire: async () => (allow ? { ok: true } : { ok: false, retryAfterS: 9 }),
      penalise: async () => {},
    };
    const { service, clock } = setup({}, limiter);
    await service.ip('1.1.1.1');
    clock.advance(2 * HOUR);
    allow = false;
    expect(await service.ip('1.1.1.1')).toMatchObject({ kind: 'record', meta: { cache: 'stale' } });
    expect(await service.asn('4608')).toMatchObject({ kind: 'error', code: 'rate_limited', retryAfterS: 9 });
  });
});

describe('RirService other lookups', () => {
  it('asn accepts messy input and answers special ASNs locally', async () => {
    const { service, rdapCalls } = setup();
    expect(await service.asn(' AS 4608 ')).toMatchObject({ kind: 'record', record: { asnStart: 4608 }, meta: { url: `${APNIC}autnum/4608` } });
    expect(await service.asn('64512')).toMatchObject({ kind: 'special', query: 'AS64512' });
    expect(rdapCalls()).toEqual([`${APNIC}autnum/4608`]);
  });

  it('entity infers the RIR from the handle suffix or asks for it', async () => {
    const { service } = setup();
    expect(await service.entity('org-arad1-ap')).toMatchObject({ kind: 'record', record: { kind: 'org' } });
    const a = await service.entity('IRT-APNICRANDNET-AU');
    expect(a).toMatchObject({ kind: 'error', code: 'invalid_input' });
    expect(a.kind === 'error' && a.message).toContain('rir');
  });

  it('entity refuses personal records without echoing their data', async () => {
    const person = { objectClassName: 'entity', handle: 'EXAMPLE-PERSON-1-AP', vcardArray: ['vcard', [['fn', {}, 'text', 'Example Person 1'], ['kind', {}, 'text', 'individual']]] };
    const { service } = setup({ [`${APNIC}entity/EXAMPLE-PERSON-1-AP`]: { body: person } });
    const a = await service.entity('EXAMPLE-PERSON-1-AP');
    expect(a).toMatchObject({ kind: 'error', code: 'personal_record' });
    expect(JSON.stringify(a)).not.toContain('Example Person');
  });

  it('reverseDns returns the delegation, walking up zones on 404', async () => {
    const { service, rdapCalls } = setup();
    expect(await service.reverseDns('1.1.1.1')).toMatchObject({ kind: 'record', record: { zone: '1.1.1.in-addr.arpa' } });
    const miss = await service.reverseDns('1.1.2.3');
    expect(miss).toMatchObject({ kind: 'error', code: 'not_found' });
    expect(rdapCalls()).toEqual([
      `${APNIC}domain/1.1.1.in-addr.arpa`,
      `${APNIC}domain/2.1.1.in-addr.arpa`, `${APNIC}domain/1.1.in-addr.arpa`, `${APNIC}domain/1.in-addr.arpa`,
    ]);
  });
});

describe('RirService.history', () => {
  it('returns APNIC history and refuses other RIRs without calling them', async () => {
    const { service, rdapCalls } = setup();
    expect(await service.history({ resource: '1.1.1.1' })).toMatchObject({ kind: 'record', record: { type: 'history' } });
    expect(await service.history({ resource: '8.8.8.8' })).toMatchObject({ kind: 'error', code: 'history_unavailable' });
    expect(rdapCalls().filter((u) => u.includes('/history/'))).toEqual([HIST_URL]);
  });

  it('re-uses cached history until the object changes after the newest record', async () => {
    let changed = '2023-04-26T22:57:58Z';
    const current = () => {
      const doc = loadFixture('rdap/apnic/ip/1.1.1.1.json') as { events: Array<{ eventAction: string; eventDate: string }> };
      return { body: { ...doc, events: doc.events.map((e) => (e.eventAction === 'last changed' ? { ...e, eventDate: changed } : e)) } };
    };
    const { service, clock, rdapCalls } = setup({ [IP_URL]: current });
    await service.history({ resource: '1.1.1.1' });
    clock.advance(2 * HOUR);
    await service.history({ resource: '1.1.1.1' });
    expect(rdapCalls().filter((u) => u === HIST_URL)).toHaveLength(1);
    changed = '2099-01-01T00:00:00Z';
    clock.advance(2 * HOUR);
    await service.history({ resource: '1.1.1.1' });
    expect(rdapCalls().filter((u) => u === HIST_URL)).toHaveLength(2);
  });

  it('infers the resource type', async () => {
    const { inferHistoryType } = await import('../../src/service/service');
    expect(inferHistoryType('1.1.1.1')).toBe('ip');
    expect(inferHistoryType('AS4608')).toBe('asn');
    expect(inferHistoryType('4608')).toBe('asn');
    expect(inferHistoryType('ORG-ARAD1-AP')).toBe('entity');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/service`
Expected: FAIL — cannot resolve `../../src/service/service`.

- [ ] **Step 3: Write the fetcher**

`packages/core/src/service/fetcher.ts`:
```ts
import type { CacheEntry, CacheStore, Clock, RateLimiter } from '../ports';
import { fetchJson, type HttpDeps } from '../rdap/client';
import { RdapError } from '../rdap/errors';
import { RIR_LABEL, type Rir } from '../rdap/rirs';
import type { ErrorCode } from './answer';

export const TTL_S = {
  current: 3600,
  currentStale: 86_400,
  notFound: 900,
  history: 7 * 86_400,
  historyStale: 30 * 86_400,
} as const;

export const WEIGHT = { current: 1, history: 5 } as const;

export type Stored<T> = { readonly found: true; readonly value: T } | { readonly found: false };

export type FetchOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly cache: 'miss' | 'hit' | 'stale'; readonly fetchedAt: number }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly retryAfterS?: number };

export interface FetchRequest<T> {
  readonly key: string;
  readonly rir: Rir;
  readonly url: string;
  readonly weight: number;
  readonly freshS: number;
  readonly staleS: number;
  readonly maxBytes: number;
  /** Must drop personal data: its output is what gets cached. */
  readonly reduce: (raw: unknown) => T;
  readonly force?: boolean;
}

export interface FetcherDeps {
  readonly http: HttpDeps;
  readonly cache: CacheStore;
  readonly limiter: RateLimiter;
  readonly clock: Clock;
  readonly rdapHosts: () => Promise<ReadonlySet<string>>;
}

const notFound = (rir: Rir): FetchOutcome<never> => ({
  ok: false,
  code: 'not_found',
  message: `Not registered in ${RIR_LABEL[rir]}; it may be unallocated or held elsewhere.`,
});

function fromEntry<T>(entry: CacheEntry<Stored<T>>, cache: 'hit' | 'stale', rir: Rir): FetchOutcome<T> {
  return entry.value.found ? { ok: true, value: entry.value.value, cache, fetchedAt: entry.fetchedAt } : notFound(rir);
}

/** cache -> coalesce -> limiter -> fetch -> reduce -> cache, with stale-on-error (spec §5). */
export class CachedFetcher {
  private readonly deps: FetcherDeps;
  private readonly inflight = new Map<string, Promise<FetchOutcome<unknown>>>();

  constructor(deps: FetcherDeps) {
    this.deps = deps;
  }

  peek<T>(key: string): Promise<CacheEntry<Stored<T>> | null> {
    return this.deps.cache.get<Stored<T>>(key);
  }

  async get<T>(req: FetchRequest<T>): Promise<FetchOutcome<T>> {
    const entry = await this.deps.cache.get<Stored<T>>(req.key);
    if (entry && !req.force && this.deps.clock.now() < entry.freshUntil) return fromEntry(entry, 'hit', req.rir);
    const running = this.inflight.get(req.key);
    if (running) return running as Promise<FetchOutcome<T>>;
    const p = this.refresh(req, entry).finally(() => this.inflight.delete(req.key));
    this.inflight.set(req.key, p);
    return p;
  }

  private async refresh<T>(req: FetchRequest<T>, entry: CacheEntry<Stored<T>> | null): Promise<FetchOutcome<T>> {
    const fallback = entry ? fromEntry(entry, 'stale', req.rir) : null;
    const permit = await this.deps.limiter.acquire(req.rir, req.weight);
    if (!permit.ok) {
      return fallback ?? {
        ok: false,
        code: 'rate_limited',
        message: `Rate limit for ${RIR_LABEL[req.rir]} lookups reached; retry in ${permit.retryAfterS}s.`,
        retryAfterS: permit.retryAfterS,
      };
    }
    try {
      const hosts = await this.deps.rdapHosts();
      const raw = await fetchJson(req.url, { maxBytes: req.maxBytes, allowRedirectTo: (h) => hosts.has(h) }, this.deps.http);
      const value = req.reduce(raw);
      await this.store(req.key, { found: true, value }, req.freshS, req.staleS);
      return { ok: true, value, cache: 'miss', fetchedAt: this.deps.clock.now() };
    } catch (err) {
      if (!(err instanceof RdapError)) throw err;
      if (err.code === 'not_found') {
        await this.store(req.key, { found: false }, TTL_S.notFound, TTL_S.notFound);
        return notFound(req.rir);
      }
      if (err.code === 'too_large') return { ok: false, code: 'too_large', message: 'The registry response was too large to process.' };
      await this.deps.limiter.penalise(req.rir);
      return fallback ?? {
        ok: false,
        code: 'upstream',
        message: `${RIR_LABEL[req.rir]} RDAP is unavailable right now (${err.code}); try again later.`,
        retryAfterS: err.retryAfterS,
      };
    }
  }

  private async store<T>(key: string, value: Stored<T>, freshS: number, staleS: number): Promise<void> {
    const t = this.deps.clock.now();
    await this.deps.cache.put<Stored<T>>(key, { value, fetchedAt: t, freshUntil: t + freshS * 1000, staleUntil: t + staleS * 1000 });
  }
}
```

- [ ] **Step 4: Write the service**

`packages/core/src/service/service.ts`:
```ts
import { parseAsn } from '../input/asn';
import { InputError } from '../input/errors';
import { inferRirFromHandle, parseHandle } from '../input/handle';
import { formatPrefix, parseIpOrCidr } from '../input/ip';
import { reverseZones } from '../input/reverse-zone';
import type { CacheStore, Clock, FetchLike, RateLimiter } from '../ports';
import { Bootstrap } from '../rdap/bootstrap';
import { MAX_BYTES, type HttpDeps } from '../rdap/client';
import { RdapError } from '../rdap/errors';
import { RIR_LABEL, type Rir } from '../rdap/rirs';
import { reduceAutnum } from '../reduce/autnum';
import { reduceDomain } from '../reduce/domain';
import { reduceEntity } from '../reduce/entity';
import { reduceHistory, type HistoryRecord } from '../reduce/history';
import { reduceNetwork } from '../reduce/network';
import type { AutnumRecord, DomainRecord, EntityRecord, NetworkRecord } from '../reduce/types';
import { expectClass } from '../reduce/util';
import { specialUseForAsn, specialUseForIp } from '../special-use';
import type { Answer } from './answer';
import { CachedFetcher, TTL_S, WEIGHT, type FetchOutcome } from './fetcher';

export interface ServiceDeps {
  readonly fetch: FetchLike;
  readonly cache: CacheStore;
  readonly limiter: RateLimiter;
  readonly clock: Clock;
  readonly userAgent: string;
  readonly timeoutMs?: number;
}

export type HistoryType = 'ip' | 'asn' | 'entity' | 'reverse_dns';

export interface HistoryRequest {
  readonly resource: string;
  readonly type?: HistoryType;
  readonly rir?: Rir;
}

type NoRecord = Exclude<Answer<never>, { kind: 'record' }>;
interface HistoryTarget {
  readonly rir: Rir;
  readonly path: string;
  readonly query: string;
  readonly loadCurrent: () => Promise<Answer<{ readonly changed?: string }>>;
}

const CURRENT = { weight: WEIGHT.current, freshS: TTL_S.current, staleS: TTL_S.currentStale, maxBytes: MAX_BYTES.current } as const;

export function inferHistoryType(resource: string): HistoryType {
  const s = resource.trim();
  try {
    parseIpOrCidr(s);
    return 'ip';
  } catch {
    // not an IP address
  }
  return /^(AS\s*)?\d+(\.\d+)?$/i.test(s) ? 'asn' : 'entity';
}

const notDelegated = (query: string): NoRecord => ({
  kind: 'error',
  code: 'not_delegated',
  message: `${query} is not delegated to a single RIR in the IANA bootstrap registry.`,
});

async function guard<T>(fn: () => Promise<Answer<T>>): Promise<Answer<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InputError) return { kind: 'error', code: 'invalid_input', message: `${err.message}. ${err.hint}` };
    if (err instanceof RdapError) return { kind: 'error', code: 'upstream', message: err.message };
    throw err;
  }
}

export class RirService {
  private readonly clock: Clock;
  private readonly bootstrap: Bootstrap;
  private readonly fetcher: CachedFetcher;

  constructor(deps: ServiceDeps) {
    const http: HttpDeps = { fetch: deps.fetch, userAgent: deps.userAgent, timeoutMs: deps.timeoutMs };
    this.clock = deps.clock;
    this.bootstrap = new Bootstrap({ http, cache: deps.cache, clock: deps.clock });
    this.fetcher = new CachedFetcher({
      http, cache: deps.cache, limiter: deps.limiter, clock: deps.clock,
      rdapHosts: () => this.bootstrap.rdapHosts(),
    });
  }

  ip(input: string): Promise<Answer<NetworkRecord>> {
    return guard(async () => {
      const p = parseIpOrCidr(input);
      const query = formatPrefix(p);
      const special = specialUseForIp(p);
      if (special) return { kind: 'special', query, special };
      const route = await this.bootstrap.routeIp(p);
      if (!route) return notDelegated(query);
      const url = `${route.baseUrl}ip/${query}`;
      const out = await this.fetcher.get({
        ...CURRENT, key: `ip:${query}`, rir: route.rir, url,
        reduce: (raw) => reduceNetwork(expectClass(raw, 'ip network'), { rir: route.rir }),
      });
      return this.toAnswer(out, route.rir, url);
    });
  }

  asn(input: string | number): Promise<Answer<AutnumRecord>> {
    return guard(async () => {
      const n = parseAsn(input);
      const query = `AS${n}`;
      const special = specialUseForAsn(n);
      if (special) return { kind: 'special', query, special };
      const route = await this.bootstrap.routeAsn(n);
      if (!route) return notDelegated(query);
      const url = `${route.baseUrl}autnum/${n}`;
      const out = await this.fetcher.get({
        ...CURRENT, key: `asn:${n}`, rir: route.rir, url,
        reduce: (raw) => reduceAutnum(expectClass(raw, 'autnum'), { rir: route.rir }),
      });
      return this.toAnswer(out, route.rir, url);
    });
  }

  entity(handleInput: string, rirInput?: Rir): Promise<Answer<EntityRecord>> {
    return guard(async () => {
      const handle = parseHandle(handleInput);
      const rir = rirInput ?? inferRirFromHandle(handle);
      if (!rir) {
        return { kind: 'error', code: 'invalid_input', message: `Cannot tell which RIR holds ${handle}; pass rir as one of apnic, arin, ripe, lacnic, afrinic.` };
      }
      const url = `${await this.bootstrap.baseUrl(rir)}entity/${encodeURIComponent(handle)}`;
      const out = await this.fetcher.get({
        ...CURRENT, key: `entity:${rir}:${handle}`, rir, url,
        reduce: (raw) => reduceEntity(expectClass(raw, 'entity'), { rir }),
      });
      const answer = this.toAnswer(out, rir, url);
      if (answer.kind !== 'record') return answer;
      if (answer.record.type === 'personal-entity') {
        return { kind: 'error', code: 'personal_record', message: `${handle} is a personal record; this service does not disclose personal contact data.` };
      }
      return { ...answer, record: answer.record };
    });
  }

  reverseDns(input: string): Promise<Answer<DomainRecord>> {
    return guard(async () => {
      const p = parseIpOrCidr(input);
      const query = formatPrefix(p);
      const special = specialUseForIp(p);
      if (special) return { kind: 'special', query, special };
      const zones = reverseZones(p);
      if (zones.length === 0) {
        return { kind: 'error', code: 'invalid_input', message: `${query} is too short for a reverse DNS zone; use an IPv4 /8 or longer, or an IPv6 /4 or longer.` };
      }
      const route = await this.bootstrap.routeIp(p);
      if (!route) return notDelegated(query);
      for (const zone of zones) {
        const url = `${route.baseUrl}domain/${zone}`;
        const out = await this.fetcher.get({
          ...CURRENT, key: `rdns:${zone}`, rir: route.rir, url,
          reduce: (raw) => reduceDomain(expectClass(raw, 'domain'), { rir: route.rir }),
        });
        if (out.ok || out.code !== 'not_found') return this.toAnswer(out, route.rir, url);
      }
      return { kind: 'error', code: 'not_found', message: `No reverse DNS delegation is registered in ${RIR_LABEL[route.rir]} for ${query} (checked ${zones.join(', ')}).` };
    });
  }

  history(req: HistoryRequest): Promise<Answer<HistoryRecord>> {
    return guard(async () => {
      const target = await this.historyTarget(req.type ?? inferHistoryType(req.resource), req);
      if ('kind' in target) return target;
      if (target.rir !== 'apnic') {
        return { kind: 'error', code: 'history_unavailable', message: `Registration history is not published via RDAP by ${RIR_LABEL[target.rir]}; only APNIC provides it.` };
      }
      const url = `${await this.bootstrap.baseUrl('apnic')}history/${target.path}`;
      const key = `hist:${target.path}`;
      const force = await this.historyIsStale(key, target.loadCurrent);
      const out = await this.fetcher.get({
        key, rir: 'apnic', url, weight: WEIGHT.history, freshS: TTL_S.history, staleS: TTL_S.historyStale,
        maxBytes: MAX_BYTES.history, force,
        reduce: (raw) => reduceHistory(raw, { rir: 'apnic', query: target.query }),
      });
      return this.toAnswer(out, 'apnic', url);
    });
  }

  private async historyTarget(type: HistoryType, req: HistoryRequest): Promise<HistoryTarget | NoRecord> {
    if (type === 'ip') {
      const p = parseIpOrCidr(req.resource);
      const query = formatPrefix(p);
      const special = specialUseForIp(p);
      if (special) return { kind: 'special', query, special };
      const route = await this.bootstrap.routeIp(p);
      if (!route) return notDelegated(query);
      return { rir: route.rir, path: `ip/${query}`, query, loadCurrent: () => this.ip(query) };
    }
    if (type === 'asn') {
      const n = parseAsn(req.resource);
      const special = specialUseForAsn(n);
      if (special) return { kind: 'special', query: `AS${n}`, special };
      const route = await this.bootstrap.routeAsn(n);
      if (!route) return notDelegated(`AS${n}`);
      return { rir: route.rir, path: `autnum/${n}`, query: `AS${n}`, loadCurrent: () => this.asn(n) };
    }
    if (type === 'entity') {
      const handle = parseHandle(req.resource);
      const current = await this.entity(handle, req.rir);
      if (current.kind === 'error' && current.code !== 'not_found') return current;
      const rir = req.rir ?? inferRirFromHandle(handle) ?? 'apnic';
      return { rir, path: `entity/${encodeURIComponent(handle)}`, query: handle, loadCurrent: async () => current };
    }
    const rd = await this.reverseDns(req.resource);
    if (rd.kind !== 'record') return rd;
    return { rir: rd.meta.rir, path: `domain/${rd.record.zone}`, query: rd.record.zone, loadCurrent: async () => rd };
  }

  /**
   * History is append-only. Refetch when the object's `last changed` date is later than the
   * newest cached history record, at most once per change date (spec §6).
   */
  private async historyIsStale(key: string, loadCurrent: HistoryTarget['loadCurrent']): Promise<boolean> {
    const entry = await this.fetcher.peek<HistoryRecord>(key);
    if (!entry || !entry.value.found || !entry.value.value.latestFrom) return false;
    const current = await loadCurrent();
    const changed = current.kind === 'record' ? current.record.changed : undefined;
    if (!changed) return false;
    return changed > entry.value.value.latestFrom && entry.fetchedAt < Date.parse(changed) + 86_400_000;
  }

  private toAnswer<T>(out: FetchOutcome<T>, rir: Rir, url: string): Answer<T> {
    if (!out.ok) return { kind: 'error', code: out.code, message: out.message, retryAfterS: out.retryAfterS };
    const ageS = Math.max(0, Math.round((this.clock.now() - out.fetchedAt) / 1000));
    return { kind: 'record', record: out.value, meta: { rir, cache: out.cache, ageS, url } };
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run packages/core/test/service && pnpm typecheck`
Expected: PASS. Check the line count: `wc -l packages/core/src/service/*.ts` — each under 400.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm test`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): add cached, rate-limited lookup service with stale fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: MCP tools, server, guide and public API

**Files:**
- Create: `packages/core/src/guide/text.ts`, `packages/core/src/tools.ts`, `packages/core/src/server.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/server.test.ts`, `packages/core/test/purity.test.ts`

**Interfaces:**
- Consumes: `RirService`, `HistoryType` (Task 11); renderers (Tasks 9–10); `Answer`, `Meta` (Task 9); `RIRS` (Task 2).
- Produces: `INSTRUCTIONS: string`, `USAGE_GUIDE: string`; `TOOL_NAMES` (readonly tuple, order fixed); `registerTools(server: McpServer, service: RirService): void`; `SERVER_INFO = { name: 'rir-mcp', version: VERSION }`; `createServer(service: RirService): McpServer`; `index.ts` re-exports: `createServer`, `TOOL_NAMES`, `RirService`, `MemoryCache`, `MemoryRateLimiter`, `DEFAULT_LIMITS`, `clampProfile`, `systemClock`, `buildUserAgent`, `VERSION`, and the types `ServiceDeps`, `CacheStore`, `RateLimiter`, `Clock`, `FetchLike`, `LimitProfile`, `Rir`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/purity.test.ts`:
```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

describe('core stays runtime-agnostic (runs on Node and Workers)', () => {
  it.each(files(SRC))('%s', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/from ['"]node:/);
    expect(text).not.toMatch(/\bBuffer\b|\bprocess\./);
    expect(text.split('\n').length).toBeLessThan(400);
  });
});
```

`packages/core/test/server.test.ts`:
```ts
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/memory/cache';
import { MemoryRateLimiter } from '../src/memory/rate-limiter';
import { DEFAULT_LIMITS } from '../src/rdap/limits';
import { createServer } from '../src/server';
import { RirService } from '../src/service/service';
import { TOOL_NAMES } from '../src/tools';
import { FakeClock } from './support/fake-clock';
import { fakeFetch } from './support/fake-fetch';
import { ianaRoutes, loadFixture } from './support/fixtures';

let client: Client | null = null;
afterEach(async () => { await client?.close(); client = null; });

async function connect(): Promise<Client> {
  const clock = new FakeClock();
  const fetch = fakeFetch({
    ...ianaRoutes(),
    'https://rdap.apnic.net/ip/1.1.1.1': { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
    'https://rdap.apnic.net/history/ip/1.1.1.1': { body: loadFixture('rdap/apnic/history-ip/1.1.1.1.json') },
  });
  const service = new RirService({ fetch, clock, userAgent: 'test', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(service).connect(serverT);
  client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(clientT);
  return client;
}

const text = (r: { content?: unknown }) => JSON.stringify(r.content);

describe('MCP server', () => {
  it('lists the five tools in a fixed order and serves instructions', async () => {
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(c.getInstructions()).toContain('Terms of Use');
  });

  it('answers an IP lookup with text and structured content', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '1.1.1.1' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('1.1.1.0/24  APNIC-LABS');
    expect(r.structuredContent).toMatchObject({ answer: 'record', rir: 'apnic', cache: 'miss' });
  });

  it('returns isError with an example for bad input', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'rdap_asn_lookup', arguments: { asn: 'AS-FOO' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('AS4608');
  });

  it('answers special-purpose space as a special answer', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'rdap_ip_lookup', arguments: { address: '192.168.1.1' } });
    expect(r.structuredContent).toMatchObject({ answer: 'special' });
  });

  it('answers point-in-time whowas', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'rdap_history', arguments: { resource: '1.1.1.1', at: '2012-01-01' } });
    expect(text(r)).toContain('Debogon-prefix');
  });

  it('serves the usage guide resource', async () => {
    const c = await connect();
    const r = await c.readResource({ uri: 'guide://usage' });
    expect(JSON.stringify(r.contents)).toContain('rdap_ip_lookup');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/server.test.ts packages/core/test/purity.test.ts`
Expected: server test FAILS — cannot resolve `../src/server`; purity test PASSES.

- [ ] **Step 3: Write the guide text**

`packages/core/src/guide/text.ts`:
```ts
export const TERMS_URL = 'https://github.com/IEISI-ORG/rir-mcp/blob/main/TERMS_OF_USE.md';

export const INSTRUCTIONS = `rir-mcp answers registry questions about IP addresses, prefixes, AS numbers, organisations and reverse DNS, using RDAP data from the five Regional Internet Registries (APNIC, ARIN, RIPE NCC, LACNIC, AFRINIC).
Tools:
- rdap_ip_lookup: who holds an address or prefix, and where to report abuse.
- rdap_asn_lookup: who holds an AS number.
- rdap_entity_lookup: an organisation or role handle seen in another answer.
- rdap_reverse_dns: the registered reverse-DNS delegation (nameservers) for an address.
- rdap_history: registration history and provenance (APNIC only); use at=YYYY-MM-DD for "who held X on that date".
Rules: one resource per call; no search, lists or bulk queries. Personal contact data is never returned. Answers can be cached for up to an hour; the "source" line says how fresh each one is.
Use is subject to the rir-mcp Terms of Use (${TERMS_URL}): no marketing to, spamming or harassment of RIR members.`;

export const USAGE_GUIDE = `# rir-mcp usage guide

Ask one question about one resource at a time.

| Question | Tool | Arguments |
|---|---|---|
| Who holds 1.1.1.1? | rdap_ip_lookup | address: "1.1.1.1" |
| Where do I report abuse from 203.0.113.0/24? | rdap_ip_lookup | address: "203.0.113.0/24" |
| Who is AS4608? | rdap_asn_lookup | asn: "AS4608" |
| What is ORG-ARAD1-AP? | rdap_entity_lookup | handle: "ORG-ARAD1-AP" |
| What is IRT-APNICRANDNET-AU? | rdap_entity_lookup | handle: "IRT-APNICRANDNET-AU", rir: "apnic" |
| What are the reverse DNS servers for 1.1.1.1? | rdap_reverse_dns | address: "1.1.1.1" |
| What's the history of 1.1.1.1? | rdap_history | resource: "1.1.1.1" |
| Who held 1.1.1.1 on 2012-01-01? | rdap_history | resource: "1.1.1.1", at: "2012-01-01" |

Not available: searching by name, listing an organisation's resources, bulk lookups, personal contact details, routing (BGP) data.

Private, documentation and other special-purpose addresses and AS numbers are answered locally without contacting any registry.

Terms of Use: ${TERMS_URL}
`;
```

- [ ] **Step 4: Write the tools and server**

`packages/core/src/tools.ts`:
```ts
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { RIRS } from './rdap/rirs';
import { renderHistory } from './render/history';
import { renderAutnum, renderDomain, renderEntity, renderNetwork, renderSpecial } from './render/text';
import type { Answer, Meta } from './service/answer';
import type { RirService } from './service/service';

export const TOOL_NAMES = ['rdap_ip_lookup', 'rdap_asn_lookup', 'rdap_entity_lookup', 'rdap_reverse_dns', 'rdap_history'] as const;

const RIR = z.enum(RIRS);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const OUTPUT = z.object({
  answer: z.enum(['record', 'special']),
  rir: z.string().optional(),
  cache: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function result<T extends object>(answer: Answer<T>, render: (record: T, meta: Meta) => string): ToolResult {
  if (answer.kind === 'error') return { content: [{ type: 'text', text: answer.message }], isError: true };
  if (answer.kind === 'special') {
    return {
      content: [{ type: 'text', text: renderSpecial(answer.query, answer.special) }],
      structuredContent: { answer: 'special', data: { query: answer.query, ...answer.special } },
    };
  }
  return {
    content: [{ type: 'text', text: render(answer.record, answer.meta) }],
    structuredContent: { answer: 'record', rir: answer.meta.rir, cache: answer.meta.cache, data: answer.record as unknown as Record<string, unknown> },
  };
}

/** Unexpected failures never leak internals to the model. */
async function safely(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch {
    return { content: [{ type: 'text', text: 'Internal error while answering this question.' }], isError: true };
  }
}

const doc = (answers: string, input: string, examples: string, not: string): string =>
  `Answers: ${answers}\nInput forms: ${input}\nExample questions: ${examples}\nDoes not: ${not}`;

export function registerTools(server: McpServer, service: RirService): void {
  server.registerTool('rdap_ip_lookup', {
    title: 'IP address / prefix registration',
    description: doc(
      'who holds an IP address or prefix: registered range, name, country, status, holder, abuse contact and dates, from the authoritative RIR.',
      'one IPv4 or IPv6 address or CIDR, e.g. 1.1.1.1, 203.0.113.0/24, 2001:db8::/32.',
      '"Who holds 1.1.1.1?", "Where do I report abuse from 8.8.8.8?"',
      'search, list or bulk-query; return personal contact details; show routing (BGP) data.',
    ),
    inputSchema: z.object({ address: z.string().max(64).describe('One IPv4/IPv6 address or CIDR') }),
    outputSchema: OUTPUT,
  }, async ({ address }) => safely(async () => result(await service.ip(address), renderNetwork)));

  server.registerTool('rdap_asn_lookup', {
    title: 'AS number registration',
    description: doc(
      'who holds an Autonomous System number: name, country, holder, abuse contact and dates.',
      'AS4608, as4608 or 4608 (asdot 1.10 also accepted).',
      '"Who is AS4608?", "Who do I contact about AS15169?"',
      'show peers, prefixes announced or routing data; return personal contact details.',
    ),
    inputSchema: z.object({ asn: z.string().max(20).describe('AS number, e.g. AS4608') }),
    outputSchema: OUTPUT,
  }, async ({ asn }) => safely(async () => result(await service.asn(asn), renderAutnum)));

  server.registerTool('rdap_entity_lookup', {
    title: 'Organisation / role handle',
    description: doc(
      'details of an organisation or role (e.g. abuse team) handle seen in another answer: name, email, roles, dates.',
      'one handle such as ORG-ARAD1-AP; add rir when the handle has no RIR suffix (e.g. IRT-APNICRANDNET-AU with rir "apnic").',
      '"What is ORG-ARAD1-AP?"',
      'search by name; list an organisation\'s resources; disclose records of individual people.',
    ),
    inputSchema: z.object({ handle: z.string().max(64).describe('Registry handle'), rir: RIR.optional() }),
    outputSchema: OUTPUT,
  }, async ({ handle, rir }) => safely(async () => result(await service.entity(handle, rir), renderEntity)));

  server.registerTool('rdap_reverse_dns', {
    title: 'Reverse DNS delegation',
    description: doc(
      'the reverse-DNS zone registered for an address or prefix, its nameservers and whether it is DNSSEC-signed (registry view, not live DNS).',
      'one IPv4 or IPv6 address or prefix; the tool works out the in-addr.arpa / ip6.arpa zone.',
      '"What are the reverse DNS servers for 1.1.1.1?"',
      'query live DNS; check whether the nameservers actually answer.',
    ),
    inputSchema: z.object({ address: z.string().max(64).describe('One IPv4/IPv6 address or prefix') }),
    outputSchema: OUTPUT,
  }, async ({ address }) => safely(async () => result(await service.reverseDns(address), renderDomain)));

  server.registerTool('rdap_history', {
    title: 'Registration history (whowas) and provenance',
    description: doc(
      'how a resource\'s registration changed over time (created, withdrawn, renamed, holder changes), or who held it on a date. APNIC only.',
      'resource = an IP/CIDR, AS number, handle, or (with type "reverse_dns") an address; optional at=YYYY-MM-DD, since=YYYY-MM-DD, detail "summary" | "full".',
      '"What\'s the history of 1.1.1.1?", "Who held 1.1.1.1 on 2012-01-01?"',
      'return history for ARIN, RIPE NCC, LACNIC or AFRINIC resources (they do not publish it); return personal data.',
    ),
    inputSchema: z.object({
      resource: z.string().max(64),
      type: z.enum(['ip', 'asn', 'entity', 'reverse_dns']).optional(),
      rir: RIR.optional(),
      at: DATE.optional(),
      since: DATE.optional(),
      detail: z.enum(['summary', 'full']).optional(),
    }),
    outputSchema: OUTPUT,
  }, async ({ resource, type, rir, at, since, detail }) => safely(async () => result(
    await service.history({ resource, type, rir }),
    (rec, meta) => renderHistory(rec, meta, { detail: detail ?? 'summary', since, at }),
  )));
}
```

`packages/core/src/server.ts`:
```ts
import { McpServer } from '@modelcontextprotocol/server';
import { INSTRUCTIONS, USAGE_GUIDE } from './guide/text';
import type { RirService } from './service/service';
import { registerTools } from './tools';
import { VERSION } from './version';

export const SERVER_INFO = { name: 'rir-mcp', version: VERSION } as const;

export function createServer(service: RirService): McpServer {
  const server = new McpServer({ ...SERVER_INFO }, { instructions: INSTRUCTIONS });
  registerTools(server, service);
  server.registerResource(
    'usage-guide',
    'guide://usage',
    { title: 'rir-mcp usage guide', description: 'Which question maps to which tool, with examples.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: USAGE_GUIDE }] }),
  );
  return server;
}
```

`packages/core/src/index.ts`:
```ts
export { MemoryCache } from './memory/cache';
export { MemoryRateLimiter } from './memory/rate-limiter';
export { systemClock, type CacheStore, type Clock, type FetchLike, type RateLimiter } from './ports';
export { clampProfile, DEFAULT_LIMITS, type LimitProfile } from './rdap/limits';
export type { Rir } from './rdap/rirs';
export { buildUserAgent } from './rdap/user-agent';
export { createServer } from './server';
export { RirService, type ServiceDeps } from './service/service';
export { TOOL_NAMES } from './tools';
export { VERSION } from './version';
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run packages/core/test/server.test.ts packages/core/test/purity.test.ts && pnpm typecheck`
Expected: PASS. If typecheck rejects the `registerTool` handler return type, compare `ToolResult` with the SDK's `CallToolResult` type (`@modelcontextprotocol/server` exports it) and align the field types; do not use `any`.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): expose five RDAP tools, instructions and usage guide over MCP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Node stdio entry point, live drift check, README

**Files:**
- Create: `packages/node/package.json`, `packages/node/src/config.ts`, `packages/node/src/stdio.ts`, `packages/core/test/live/live.test.ts`, `README.md`
- Test: `packages/node/test/config.test.ts`, `packages/node/test/stdio.test.ts`

**Interfaces:**
- Consumes: the `@ieisi/rir-mcp-core` public API (Task 12).
- Produces: `loadConfig(env: Record<string, string | undefined>): NodeConfig` where `NodeConfig = { operator: string; userAgent: string }` (throws `ConfigError`); an executable `packages/node/src/stdio.ts`.

- [ ] **Step 1: Create the package and write failing tests**

`packages/node/package.json`:
```json
{
  "name": "@ieisi/rir-mcp-node",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@ieisi/rir-mcp-core": "workspace:*",
    "@modelcontextprotocol/server": "^2.2.0"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.2.0"
  }
}
```

Run: `pnpm install`

`packages/node/test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('requires an operator contact', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ RIR_MCP_OPERATOR: '  ' })).toThrow('RIR_MCP_OPERATOR');
  });

  it('rejects contacts that could break the User-Agent', () => {
    expect(() => loadConfig({ RIR_MCP_OPERATOR: 'a\r\nX-Evil: 1' })).toThrow(ConfigError);
  });

  it('builds the User-Agent', () => {
    expect(loadConfig({ RIR_MCP_OPERATOR: 'noc@example.net' })).toEqual({
      operator: 'noc@example.net',
      userAgent: 'rir-mcp/0.1.0 (+https://github.com/IEISI-ORG/rir-mcp; operator=noc@example.net)',
    });
  });
});
```

`packages/node/test/stdio.test.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES } from '@ieisi/rir-mcp-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const ENTRY = join(ROOT, 'packages/node/src/stdio.ts');

describe('stdio server', () => {
  it('lists tools and answers special-purpose space without network access', async () => {
    const transport = new StdioClientTransport({
      command: TSX,
      args: [ENTRY],
      env: { PATH: process.env.PATH ?? '', RIR_MCP_OPERATOR: 'test@example.net' },
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      const r = await client.callTool({ name: 'rdap_ip_lookup', arguments: { address: '10.1.2.3' } });
      expect(JSON.stringify(r.content)).toContain('Private-Use (RFC 1918)');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('exits 1 with a clear message when no operator is configured', () => {
    const run = spawnSync(TSX, [ENTRY], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('RIR_MCP_OPERATOR');
  }, 30_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/node`
Expected: FAIL — cannot resolve `../src/config`.

- [ ] **Step 3: Write the implementation**

`packages/node/src/config.ts`:
```ts
import { buildUserAgent } from '@ieisi/rir-mcp-core';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface NodeConfig {
  readonly operator: string;
  readonly userAgent: string;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): NodeConfig {
  const operator = env.RIR_MCP_OPERATOR?.trim() ?? '';
  if (operator === '') {
    throw new ConfigError(
      'RIR_MCP_OPERATOR is required: a contact email or URL for whoever runs this server. ' +
        'It is sent in the User-Agent so the RIRs can reach you.',
    );
  }
  try {
    return { operator, userAgent: buildUserAgent(operator) };
  } catch (err) {
    throw new ConfigError(`RIR_MCP_OPERATOR is invalid: ${(err as Error).message}`);
  }
}
```

`packages/node/src/stdio.ts`:
```ts
import { createServer, DEFAULT_LIMITS, MemoryCache, MemoryRateLimiter, RirService, systemClock } from '@ieisi/rir-mcp-core';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config';

let userAgent: string;
try {
  userAgent = loadConfig(process.env).userAgent;
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`rir-mcp: ${err.message}`);
  process.exit(1);
}

const service = new RirService({
  fetch: (url, init) => fetch(url, init),
  cache: new MemoryCache(systemClock),
  limiter: new MemoryRateLimiter(DEFAULT_LIMITS, systemClock),
  clock: systemClock,
  userAgent,
});

serveStdio(() => createServer(service));
// stdout carries the protocol; diagnostics go to stderr only.
console.error('rir-mcp: listening on stdio');
```

`packages/core/test/live/live.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { buildUserAgent, DEFAULT_LIMITS, MemoryCache, MemoryRateLimiter, RirService, systemClock } from '../../src/index';
import { renderNetwork } from '../../src/render/text';

// Opt-in: RIR_MCP_LIVE=1 RIR_MCP_OPERATOR=you@example.net pnpm test:live  (one query per RIR)
describe.skipIf(process.env.RIR_MCP_LIVE !== '1')('live RDAP drift check', () => {
  let service: RirService;
  beforeAll(() => {
    service = new RirService({
      fetch: (url, init) => fetch(url, init),
      cache: new MemoryCache(systemClock),
      limiter: new MemoryRateLimiter(DEFAULT_LIMITS, systemClock),
      clock: systemClock,
      userAgent: buildUserAgent(process.env.RIR_MCP_OPERATOR ?? ''),
    });
  });

  it.each([
    ['apnic', '1.1.1.1'], ['arin', '8.8.8.8'], ['ripe', '193.0.6.139'], ['lacnic', '200.3.14.10'], ['afrinic', '196.216.2.1'],
  ])('%s answers %s', async (rir, ip) => {
    const a = await service.ip(ip);
    expect(a.kind).toBe('record');
    if (a.kind !== 'record') return;
    expect(a.meta.rir).toBe(rir);
    expect(a.record.prefixes.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(renderNetwork(a.record, a.meta)).length).toBeLessThan(600);
  }, 30_000);
});
```

`README.md`:
````markdown
# rir-mcp

An MCP server that answers registry questions about IP addresses, prefixes, AS numbers, organisations and reverse DNS, using RDAP data from the five Regional Internet Registries (APNIC, ARIN, RIPE NCC, LACNIC, AFRINIC), plus APNIC registration history (whowas).

- Compact answers: typically ~300 bytes instead of 4–250 KB of raw RDAP JSON.
- No personal data: contacts of individual people are never returned or stored.
- Polite to the registries: per-RIR rate limits, caching, and a User-Agent that names the operator.

Status: early development (Plan 1 of 4: local stdio server). Design: `docs/superpowers/specs/2026-09-30-rir-mcp-core-design.md`.

## Run locally with Claude Code

Requires Node 22+ and pnpm.

```bash
git clone https://github.com/IEISI-ORG/rir-mcp && cd rir-mcp
pnpm install
claude mcp add rir-mcp --env RIR_MCP_OPERATOR=you@example.net -- \
  "$PWD/node_modules/.bin/tsx" "$PWD/packages/node/src/stdio.ts"
```

`RIR_MCP_OPERATOR` is required: a contact email or URL for whoever runs the server. It is sent to the registries in the User-Agent.

Then ask, for example: "Who holds 1.1.1.1?", "Who is AS4608?", "What's the history of 1.1.1.1?".

## Tests

```bash
pnpm test                                                  # offline, uses recorded fixtures
RIR_MCP_OPERATOR=you@example.net pnpm test:live            # one live query per RIR
```

## Terms of Use

Use is subject to the rir-mcp Terms of Use (to be published): no marketing to, spamming or harassment of RIR members.
````

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/node && pnpm test && pnpm typecheck`
Expected: all PASS (live test reported as skipped).

- [ ] **Step 5: Live smoke test (network, 5 queries)**

Run: `RIR_MCP_OPERATOR=<your contact email> pnpm test:live`
Expected: 5 PASS. A failure here means an RIR's format differs from the fixtures: stop and report the RIR and the assertion.

- [ ] **Step 6: Commit**

```bash
git add packages/node packages/core/test/live README.md pnpm-lock.yaml
git commit -m "feat(node): serve rir-mcp over stdio with operator-identified User-Agent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Deferred to later plans

- **Plan 2 — Node HTTP:** Streamable HTTP via `createMcpHandler`, `Origin` validation (403), 127.0.0.1 default bind, bearer keys (single `RIR_MCP_API_KEY` or keys file of SHA-256 hashes), per-client quota, distinct-prefix scan detector.
- **Plan 3 — Cloudflare Worker:** `StateDO` (SQLite cache, limiter, quotas, deny-list), secret-or-KV auth (fail closed), Vitest plugin tests.
- **Plan 4 — Governance and CI:** `LICENSE` (OpenRAIL-S), `TERMS_OF_USE.md`, `SECURITY.md`, `CONTRIBUTING.md` (blocked on APNIC Legal Counsel review); GitHub Actions for tests on PRs, the weekly `test:live` drift job, Dependabot, CodeQL and secret scanning (spec §7, §9).
