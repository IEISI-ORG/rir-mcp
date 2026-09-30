import type { AutnumRecord, DomainRecord, EntityRecord, NetworkRecord } from '../reduce/types';
import type { SpecialUse } from '../special-use';
import type { Meta } from '../service/answer';
import { contactText, datesText, details, holderText, lines, sourceText } from './format';

export function renderNetwork(r: NetworkRecord, meta: Meta): string {
  const head = [r.prefixes.join(' ') || r.handle, r.name].filter(Boolean).join('  ');
  return lines([
    ['network', head + details(r.country, r.allocationType, ...r.status)],
    ['holder', holderText(r.holder)],
    ['abuse', contactText(r.abuse, meta.url)],
    ['tech', contactText(r.tech)],
    ['dates', datesText(r.registered, r.changed)],
    ['source', sourceText(meta)],
  ]);
}

export function renderAutnum(r: AutnumRecord, meta: Meta): string {
  const asn = r.asnStart === undefined ? r.handle
    : r.asnEnd !== undefined && r.asnEnd !== r.asnStart ? `AS${r.asnStart}-AS${r.asnEnd}` : `AS${r.asnStart}`;
  return lines([
    ['asn', [asn, r.name].filter(Boolean).join('  ') + details(r.country, ...r.status)],
    ['holder', holderText(r.holder)],
    ['abuse', contactText(r.abuse, meta.url)],
    ['tech', contactText(r.tech)],
    ['dates', datesText(r.registered, r.changed)],
    ['source', sourceText(meta)],
  ]);
}

export function renderEntity(r: EntityRecord, meta: Meta): string {
  return lines([
    ['entity', `${r.name ?? r.handle}  [${r.handle}]  (${r.kind})`],
    ['email', r.email],
    ['roles', r.roles.length > 0 ? r.roles.join(', ') : undefined],
    ['dates', datesText(r.registered, r.changed)],
    ['source', sourceText(meta)],
  ]);
}

export function renderDomain(r: DomainRecord, meta: Meta): string {
  return lines([
    ['zone', r.zone],
    ['nameservers', r.nameservers.length > 0 ? r.nameservers.join(', ') : 'none registered'],
    ['dnssec', r.signed ? 'signed' : 'not signed (no DS in registry)'],
    ['dates', datesText(r.registered, r.changed)],
    ['source', sourceText(meta)],
  ]);
}

export function renderSpecial(query: string, s: SpecialUse): string {
  return `${query}  ${s.name} (${s.ref}): IANA special-purpose space, not registered to any organisation. No RDAP lookup was made.`;
}
