import { RdapError } from '../rdap/errors';
import { clean } from './sanitize';

export type Obj = Record<string, unknown>;

export function asObject(v: unknown): Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

export function strings(v: unknown, max = 40): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const c = clean(x, max);
    return c ? [c] : [];
  });
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
