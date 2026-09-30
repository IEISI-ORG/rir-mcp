import { clean } from './sanitize';
import type { EntityRecord, PersonalEntity, ReduceCtx } from './types';
import { asObject, eventDate, strings } from './util';
import { entityKind, isPersonLike, vcardValue, vcardValues } from './vcard';

export function reduceEntity(raw: unknown, ctx: ReduceCtx): EntityRecord | PersonalEntity {
  const o = asObject(raw);
  if (isPersonLike(o)) return { type: 'personal-entity', rir: ctx.rir };
  return {
    type: 'entity',
    rir: ctx.rir,
    handle: clean(o.handle, 64) ?? 'UNKNOWN',
    kind: entityKind(o) === 'group' ? 'group' : 'org',
    name: clean(vcardValue(o, 'fn')),
    email: clean(vcardValues(o, 'email')[0], 254),
    roles: strings(o.roles),
    registered: eventDate(o, 'registration'),
    changed: eventDate(o, 'last changed'),
  };
}
