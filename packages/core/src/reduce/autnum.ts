import { flattenEntities, partyFor } from './entities';
import { abuseParty } from './network';
import { clean } from './sanitize';
import type { AutnumRecord, ReduceCtx } from './types';
import { asObject, eventDate, strings } from './util';

export function reduceAutnum(raw: unknown, ctx: ReduceCtx): AutnumRecord {
  const o = asObject(raw);
  const ents = flattenEntities(o);
  const holder = partyFor(ents, 'registrant');
  const start = typeof o.startAutnum === 'number' ? o.startAutnum : undefined;
  const end = typeof o.endAutnum === 'number' ? o.endAutnum : start;
  return {
    type: 'autnum',
    rir: ctx.rir,
    handle: clean(o.handle, 64) ?? 'UNKNOWN',
    asnStart: start,
    asnEnd: end,
    name: clean(o.name),
    country: clean(o.country, 3),
    status: strings(o.status),
    holder,
    abuse: abuseParty(ents, holder),
    tech: partyFor(ents, 'technical'),
    admin: partyFor(ents, 'administrative'),
    registered: eventDate(o, 'registration'),
    changed: eventDate(o, 'last changed'),
  };
}
