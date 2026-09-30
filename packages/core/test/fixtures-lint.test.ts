import { describe, expect, it } from 'vitest';
import { isPersonLike, vcardValue, vcardValues } from '../src/reduce/vcard';
import { PERSON_KEY } from './support/scrub';
import { listFixtures, loadFixture } from './support/fixtures';

function collect(node: unknown, people: unknown[], notes: unknown[][], personFields: Array<[string, unknown]>): void {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, people, notes, personFields)); return; }
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if ('vcardArray' in obj && isPersonLike(obj)) people.push(obj);
  if (Array.isArray(obj.remarks)) notes.push(obj.remarks);
  for (const [k, v] of Object.entries(obj)) {
    if (PERSON_KEY.test(k)) personFields.push([k, v]);
  }
  Object.values(obj).forEach((v) => collect(v, people, notes, personFields));
}

describe('committed RDAP fixtures hold no real personal data', () => {
  const files = listFixtures('rdap');

  it('exist', () => {
    expect(files.length).toBeGreaterThanOrEqual(16);
  });

  it.each(files)('%s', (rel) => {
    const people: unknown[] = [];
    const notes: unknown[][] = [];
    const personFields: Array<[string, unknown]> = [];
    collect(loadFixture(rel), people, notes, personFields);
    for (const p of people) {
      expect(vcardValue(p, 'fn')).toMatch(/^Example Person \d+$/);
      for (const email of vcardValues(p, 'email')) expect(email).toMatch(/^person-\d+@example\.net$/);
      expect((p as { handle?: string }).handle).toMatch(/^EXAMPLE-PERSON-\d+$/);
    }
    for (const list of notes) {
      for (const note of list) expect((note as { description?: unknown }).description).toEqual(['[scrubbed]']);
    }
    for (const [k, v] of personFields) {
      expect(v).toBe('[scrubbed]');
    }
  });
});
