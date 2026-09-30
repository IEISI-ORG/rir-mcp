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
