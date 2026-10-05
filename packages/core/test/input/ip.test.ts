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

describe('prefixContains, IPv6 and equal prefixes', () => {
  it('contains equal prefixes and more-specifics, not less-specifics or other families', () => {
    const p = (v: string) => parseIpOrCidr(v);
    expect(prefixContains(p('2001:db8::/32'), p('2001:db8::/32'))).toBe(true);
    expect(prefixContains(p('2001:db8::/32'), p('2001:db8:1::/48'))).toBe(true);
    expect(prefixContains(p('2001:db8:1::/48'), p('2001:db8::/32'))).toBe(false);
    expect(prefixContains(p('2001:db8::/32'), p('2001:db9::1'))).toBe(false);
    expect(prefixContains(p('0.0.0.0/0'), p('::/0'))).toBe(false);
  });
});

describe('rangeToCidrs limit (audit 2026-10-06 I2)', () => {
  it('stops at the limit instead of computing every block of a worst-case IPv6 range', () => {
    const start = parseIpOrCidr('::1').value;
    const end = parseIpOrCidr('ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe').value; // about 254 blocks
    const t = performance.now();
    for (let i = 0; i < 2000; i++) expect(rangeToCidrs(6, start, end, 4)).toHaveLength(4);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('prefix length spelling', () => {
  it.each(['1.1.1.0/024', '2001:db8::/032', '1.1.1.0/00'])('refuses a non-canonical length with leading zeros (%s)', (v) => {
    expect(() => parseIpOrCidr(v)).toThrow(/prefix length/);
  });

  it('still accepts /0 and ordinary lengths', () => {
    expect(formatPrefix(parseIpOrCidr('0.0.0.0/0'))).toBe('0.0.0.0/0');
    expect(formatPrefix(parseIpOrCidr('2001:db8::/32'))).toBe('2001:db8::/32');
  });
});

describe('rangeToCidrs edge cases', () => {
  it('handles a single address, an IPv6 range, and an inverted range', () => {
    const a = parseIpOrCidr('192.0.2.7');
    expect(rangeToCidrs(4, a.value, a.value).map(formatCidr)).toEqual(['192.0.2.7/32']);
    const s6 = parseIpOrCidr('2001:db8::');
    const e6 = parseIpOrCidr('2001:db8::1:ffff');
    expect(rangeToCidrs(6, s6.value, e6.value).map(formatCidr)).toEqual(['2001:db8::/111']); // exactly one /111
    expect(rangeToCidrs(4, a.value + 1n, a.value)).toEqual([]);
  });
});

describe('rangeToCidrs', () => {
  it('returns the minimal CIDR cover', () => {
    const a = parseIpOrCidr('1.1.1.0'), b = parseIpOrCidr('1.1.1.255'), c = parseIpOrCidr('1.1.2.127');
    expect(rangeToCidrs(4, a.value, b.value).map(formatCidr)).toEqual(['1.1.1.0/24']);
    expect(rangeToCidrs(4, a.value, c.value).map(formatCidr)).toEqual(['1.1.1.0/24', '1.1.2.0/25']);
  });
});
