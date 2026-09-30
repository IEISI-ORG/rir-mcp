import { describe, expect, it } from 'vitest';
import { entityKind, isPersonLike, vcardValue, vcardValues } from '../../src/reduce/vcard';
import { scrubRdap } from '../support/scrub';

const entity = (kind: string | null, extra: unknown[] = []) => ({
  handle: 'H-1',
  vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Real Name'],
    ...(kind ? [['kind', {}, 'text', kind]] : []), ['email', {}, 'text', 'a@b.c'], ['email', {}, 'text', 'd@e.f'], ...extra]],
});

describe('vcard helpers', () => {
  it('reads values', () => {
    expect(vcardValue(entity('org'), 'fn')).toBe('Real Name');
    expect(vcardValues(entity('org'), 'email')).toEqual(['a@b.c', 'd@e.f']);
    expect(entityKind(entity('ORG'))).toBe('org');
    expect(vcardValue({}, 'fn')).toBeUndefined();
    expect(vcardValue({ vcardArray: 'junk' }, 'fn')).toBeUndefined();
  });

  it('treats anything but org/group as a person', () => {
    expect(isPersonLike(entity('org'))).toBe(false);
    expect(isPersonLike(entity('group'))).toBe(false);
    expect(isPersonLike(entity('individual'))).toBe(true);
    expect(isPersonLike(entity(null))).toBe(true);
    expect(isPersonLike({})).toBe(true);
  });
});

describe('scrubRdap', () => {
  it('replaces people and remarks, keeps orgs and structure', () => {
    const doc = {
      objectClassName: 'ip network',
      remarks: [{ title: 'r', description: ['call Jane on 555'] }],
      entities: [
        { ...entity('org'), roles: ['registrant'], entities: [{ ...entity('individual'), roles: ['technical'], links: [{ href: 'x' }] }] },
        { ...entity(null), roles: ['abuse'] },
      ],
    };
    const out = scrubRdap(doc) as typeof doc;
    const json = JSON.stringify(out);
    expect(json).not.toContain('555');
    expect(json).not.toContain('Jane');
    expect(vcardValue(out.entities[0], 'fn')).toBe('Real Name');
    const person = (out.entities[0] as { entities: unknown[] }).entities[0];
    expect(vcardValue(person, 'fn')).toBe('Example Person 1');
    expect((person as { handle: string }).handle).toBe('EXAMPLE-PERSON-1');
    expect((person as { links?: unknown }).links).toBeUndefined();
    expect(vcardValue(out.entities[1], 'fn')).toBe('Example Person 2');
    expect(out.remarks[0]?.description).toEqual(['[scrubbed]']);
  });

  it('scrubs registry-specific person fields outside vCards', () => {
    const doc = {
      objectClassName: 'autonomous system',
      lacnic_legalRepresentative: 'Jane Roe',
      entities: [entity('org')],
    };
    const out = scrubRdap(doc) as Record<string, unknown>;
    expect(out.lacnic_legalRepresentative).toBe('[scrubbed]');
    const json = JSON.stringify(out);
    expect(json).not.toContain('Jane Roe');
  });
});
