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
