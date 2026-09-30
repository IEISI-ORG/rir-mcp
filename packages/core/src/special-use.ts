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
