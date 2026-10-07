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

describe('nested special-purpose blocks (Task 3 follow-up: longest match)', () => {
  it.each([
    ['192.0.0.1', 'IPv4 Service Continuity Prefix'],
    ['192.0.0.200', 'IETF Protocol Assignments'],
    ['2001:0:1::1', 'TEREDO'],
    ['2001:1::1', 'IETF Protocol Assignments'],
  ])('%s is %s: the most specific registry entry wins', (ip, name) => {
    expect(specialUseForIp(parseIpOrCidr(ip))?.name).toBe(name);
  });
});

