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
