import { isPersonLike } from '../../src/reduce/vcard';

// Registry-specific fields that name people outside vCards (e.g. LACNIC's lacnic_legalRepresentative).
export const PERSON_KEY = /representative|person|contact|owner|responsible/i;

/**
 * Replaces every person-like entity's identifying values with synthetic ones and blanks
 * remarks/notices text, keeping structure (nesting, roles, kind) for reducer tests.
 */
export function scrubRdap(doc: unknown): unknown {
  let n = 0;
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node === null || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'remarks' || k === 'notices') {
        out[k] = scrubNotes(v);
      } else if (PERSON_KEY.test(k) && typeof v === 'string') {
        out[k] = '[scrubbed]';
      } else {
        out[k] = visit(v);
      }
    }
    if ('vcardArray' in obj && isPersonLike(obj)) {
      n += 1;
      out.handle = `EXAMPLE-PERSON-${n}`;
      out.vcardArray = ['vcard', [
        ['version', {}, 'text', '4.0'],
        ['fn', {}, 'text', `Example Person ${n}`],
        ['kind', {}, 'text', 'individual'],
        ['email', {}, 'text', `person-${n}@example.net`],
        ['tel', { type: 'voice' }, 'uri', 'tel:+00-0000-0000'],
      ]];
      delete out.links;
    }
    return out;
  };
  return visit(doc);
}

function scrubNotes(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v.map((note) => ({ ...(note as Record<string, unknown>), description: ['[scrubbed]'] }));
}
