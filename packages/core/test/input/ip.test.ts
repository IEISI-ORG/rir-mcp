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
