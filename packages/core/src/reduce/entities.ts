import { clean } from './sanitize';
import type { Contact, Party } from './types';
import { asObject, LIMITS, type Obj } from './util';
import { isPersonLike, vcardValue, vcardValues } from './vcard';

export interface FlatEntity {
  readonly entity: Obj;
  readonly roles: readonly string[];
}

/** All entities with their roles, including nested ones (ARIN/RIPE nest abuse under the org). */
export function flattenEntities(o: Obj, depth = 0, out: FlatEntity[] = []): FlatEntity[] {
  if (depth > 3 || !Array.isArray(o.entities)) return out;
  for (const raw of o.entities) {
    // Bounded in total, not per level: four levels of 100 would otherwise be 100^4 entries.
    if (out.length >= LIMITS.entities) break;
    const entity = asObject(raw);
    const roles = Array.isArray(entity.roles) ? entity.roles.filter((r): r is string => typeof r === 'string').slice(0, LIMITS.strings) : [];
    out.push({ entity, roles });
    flattenEntities(entity, depth + 1, out);
  }
  return out;
}

export function toContact(e: Obj): Contact {
  return {
    handle: clean(e.handle, 64) ?? 'UNKNOWN',
    name: clean(vcardValue(e, 'fn')),
    email: clean(vcardValues(e, 'email')[0], 254),
  };
}

/** Org/group contact for a role if any; otherwise mark the role as held by a person. */
export function partyFor(ents: readonly FlatEntity[], role: string): Party | undefined {
  const matches = ents.filter((x) => x.roles.includes(role));
  if (matches.length === 0) return undefined;
  const org = matches.find((x) => !isPersonLike(x.entity));
  return org ? toContact(org.entity) : { personal: true };
}
