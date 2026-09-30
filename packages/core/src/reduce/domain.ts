import { clean } from './sanitize';
import type { DomainRecord, ReduceCtx } from './types';
import { asObject, eventDate } from './util';

const dnsName = (v: unknown): string | undefined => clean(v, 253)?.toLowerCase().replace(/\.$/, '');

export function reduceDomain(raw: unknown, ctx: ReduceCtx): DomainRecord {
  const o = asObject(raw);
  const nameservers = (Array.isArray(o.nameservers) ? o.nameservers : []).flatMap((n) => {
    const name = dnsName(asObject(n).ldhName);
    return name ? [name] : [];
  });
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
