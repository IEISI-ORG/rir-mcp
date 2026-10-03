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
