import { RdapError } from '../rdap/errors';
import { clean } from './sanitize';

export type Obj = Record<string, unknown>;

export function asObject(v: unknown): Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

/**
 * Upper bounds on registry arrays (audit 2026-10-03 #4), far above anything real records hold: a hostile or broken
 * response must not turn into a huge answer or cache entry.
 */
export const LIMITS = { strings: 16, prefixes: 64, nameservers: 32, entities: 128 } as const;

export function strings(v: unknown, max = 40, limit: number = LIMITS.strings): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (out.length >= limit) break;
    const c = clean(x, max);
    if (c) out.push(c);
  }
  return out;
}

export function eventDate(o: Obj, action: string): string | undefined {
  if (!Array.isArray(o.events)) return undefined;
  for (const raw of o.events) {
    const e = asObject(raw);
    if (e.eventAction === action && typeof e.eventDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e.eventDate)) {
      return e.eventDate.slice(0, 10);
    }
  }
  return undefined;
}

export function expectClass(raw: unknown, cls: string): Obj {
  const o = asObject(raw);
  if (o.objectClassName !== cls) throw new RdapError('bad_response', `Expected an RDAP "${cls}" object`);
  return o;
}
