import { clean } from './sanitize';
import type { DomainRecord, ReduceCtx } from './types';
import { asObject, eventDate, LIMITS } from './util';

export const dnsName = (v: unknown): string | undefined => clean(v, 253, { host: true })?.toLowerCase().replace(/\.$/, '');

export function reduceDomain(raw: unknown, ctx: ReduceCtx): DomainRecord {
  const o = asObject(raw);
  const nameservers: string[] = [];
  for (const n of Array.isArray(o.nameservers) ? o.nameservers : []) {
    if (nameservers.length >= LIMITS.nameservers) break;
    const name = dnsName(asObject(n).ldhName);
    if (name) nameservers.push(name);
  }
  const sec = asObject(o.secureDNS);
  return {
    type: 'domain',
    rir: ctx.rir,
    zone: dnsName(o.ldhName) ?? '',
    nameservers,
    signed: sec.delegationSigned === true || (Array.isArray(sec.dsData) && sec.dsData.length > 0),
    registered: eventDate(o, 'registration'),
    changed: eventDate(o, 'last changed'),
  };
}
