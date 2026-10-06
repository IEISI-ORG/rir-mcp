import type { DomainRecord, ReduceCtx } from './types';
import { asObject, eventDate, LIMITS } from './util';

/** LDH labels (RFC 1123): RDAP's ldhName is exactly this, so a real name always passes and nothing in it needs defanging. */
const LDH = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * A DNS name, or undefined when the value is not LDH. Anything else could be a disguised link: GFM links a leading
 * "www." through to the next space, so "www.paypal.com:x@evil.example" would go to evil.example (audit 2026-10-07 L1).
 */
export function dnsName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const name = v.trim().toLowerCase().replace(/\.$/, '');
  return LDH.test(name) ? name : undefined;
}

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
