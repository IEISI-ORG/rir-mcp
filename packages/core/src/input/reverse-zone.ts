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
