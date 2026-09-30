import { formatCidr, parseIpOrCidr, rangeToCidrs } from '../input/ip';
import { flattenEntities, partyFor, type FlatEntity } from './entities';
import { clean } from './sanitize';
import { isPersonal, type NetworkRecord, type Party, type ReduceCtx } from './types';
import { asObject, eventDate, strings, type Obj } from './util';

export function prefixesOf(o: Obj): string[] {
  const out: string[] = [];
  if (Array.isArray(o.cidr0_cidrs)) {
    for (const raw of o.cidr0_cidrs) {
      const c = asObject(raw);
      const base = c.v4prefix ?? c.v6prefix;
      if (typeof base !== 'string' || typeof c.length !== 'number') continue;
      try {
        out.push(formatCidr(parseIpOrCidr(`${base}/${c.length}`)));
      } catch {
        // Ignore a malformed cidr0 entry; the range fallback may still work.
      }
    }
  }
  if (out.length > 0) return out;
  if (typeof o.startAddress === 'string' && typeof o.endAddress === 'string') {
    try {
      const a = parseIpOrCidr(o.startAddress);
      const b = parseIpOrCidr(o.endAddress);
      if (a.family === b.family && a.value <= b.value) return rangeToCidrs(a.family, a.value, b.value).map((p) => formatCidr(p));
    } catch {
      // Malformed range: no prefixes.
    }
  }
  return [];
}

/** Abuse role if present; else the holder's own email (only if the holder is an org/group). */
export function abuseParty(ents: readonly FlatEntity[], holder: Party | undefined): Party | undefined {
  const abuse = partyFor(ents, 'abuse');
  if (abuse) return abuse;
  return holder && !isPersonal(holder) && holder.email ? holder : undefined;
}

export function reduceNetwork(raw: unknown, ctx: ReduceCtx): NetworkRecord {
  const o = asObject(raw);
  const ents = flattenEntities(o);
  const holder = partyFor(ents, 'registrant');
  return {
    type: 'network',
    rir: ctx.rir,
    handle: clean(o.handle, 64) ?? 'UNKNOWN',
    prefixes: prefixesOf(o),
    name: clean(o.name),
    country: clean(o.country, 3),
    allocationType: clean(o.type, 40),
    status: strings(o.status),
    holder,
    abuse: abuseParty(ents, holder),
    tech: partyFor(ents, 'technical'),
    admin: partyFor(ents, 'administrative'),
    registered: eventDate(o, 'registration'),
    changed: eventDate(o, 'last changed'),
  };
}
