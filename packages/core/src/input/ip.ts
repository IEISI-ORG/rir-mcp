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
    // Canonical digits only: /024 is refused rather than silently read as /24.
    if (!/^(0|[1-9]\d{0,2})$/.test(len) || Number(len) > bits) {
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

/** The minimal CIDR cover of start..end, stopping after `limit` blocks (callers cap the result anyway). */
export function rangeToCidrs(family: IpFamily, start: bigint, end: bigint, limit = Infinity): IpPrefix[] {
  const bits = BITS[family];
  const out: IpPrefix[] = [];
  let cur = start;
  while (cur <= end && out.length < limit) {
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
