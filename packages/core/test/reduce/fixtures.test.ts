import { describe, expect, it } from 'vitest';
import { reduceAutnum } from '../../src/reduce/autnum';
import { reduceDomain } from '../../src/reduce/domain';
import { reduceEntity } from '../../src/reduce/entity';
import { reduceNetwork } from '../../src/reduce/network';
import { asObject } from '../../src/reduce/util';
import { loadFixture, rdapFixtures, rirOf } from '../support/fixtures';

const REDUCERS = { ip: reduceNetwork, autnum: reduceAutnum, entity: reduceEntity, domain: reduceDomain } as const;
const CLASS = { ip: 'ip network', autnum: 'autnum', entity: 'entity', domain: 'domain' } as const;
type Kind = keyof typeof REDUCERS;

export function reduceFixture(rel: string): unknown {
  const kind = rel.split('/')[2] as Kind;
  return REDUCERS[kind](loadFixture(rel), { rir: rirOf(rel) });
}

describe('reducers on recorded fixtures', () => {
  it.each(rdapFixtures(Object.keys(REDUCERS)))('%s: class, no leaks, snapshot', (rel) => {
    const kind = rel.split('/')[2] as Kind;
    expect(asObject(loadFixture(rel)).objectClassName).toBe(CLASS[kind]);
    const record = reduceFixture(rel);
    const json = JSON.stringify(record);
    for (const marker of ['Example Person', 'example.net', 'EXAMPLE-PERSON', '[scrubbed]']) {
      expect(json).not.toContain(marker);
    }
    expect(record).toMatchSnapshot();
  });

  it('APNIC 1.1.1.1', () => {
    const r = reduceNetwork(loadFixture('rdap/apnic/ip/1.1.1.1.json'), { rir: 'apnic' });
    expect(r.prefixes).toEqual(['1.1.1.0/24']);
    expect(r.name).toBe('APNIC-LABS');
    expect(r.country).toBe('AU');
    expect(r.holder).toMatchObject({ handle: 'ORG-ARAD1-AP', name: 'APNIC Research and Development' });
    expect(r.abuse).toMatchObject({ handle: 'IRT-APNICRANDNET-AU', email: 'helpdesk@apnic.net' });
    expect(r.registered).toBe('2011-08-10');
  });

  it('APNIC 2001:dc0::1', () => {
    const r = reduceNetwork(loadFixture('rdap/apnic/ip/2001_dc0__1.json'), { rir: 'apnic' });
    expect(r.name).toBe('APNIC-AP-V6-JP');
    expect(r.prefixes).toEqual(['2001:dc0::/35']);
  });

  it('ARIN 8.8.8.8 and AS15169', () => {
    const net = reduceNetwork(loadFixture('rdap/arin/ip/8.8.8.8.json'), { rir: 'arin' });
    expect(net.prefixes).toEqual(['8.8.8.0/24']);
    expect(net.name).toBe('GOGL');
    expect(net.holder).toHaveProperty('handle');
    expect(net.abuse).toHaveProperty('handle');
    expect(reduceAutnum(loadFixture('rdap/arin/autnum/15169.json'), { rir: 'arin' }).name).toBe('GOOGLE');
  });

  it('RIPE 193.0.6.139 and AS3333: org holder despite individual registrants', () => {
    const net = reduceNetwork(loadFixture('rdap/ripe/ip/193.0.6.139.json'), { rir: 'ripe' });
    expect(net.name).toBe('RIPE-NCC');
    expect(net.prefixes).toEqual(['193.0.0.0/21']);
    expect(net.holder).toHaveProperty('handle');
    expect(net.abuse).toHaveProperty('handle');
    expect(reduceAutnum(loadFixture('rdap/ripe/autnum/3333.json'), { rir: 'ripe' }).name).toBe('RIPE-NCC-AS');
  });

  it('LACNIC 200.3.14.10: personal abuse and tech contacts', () => {
    const net = reduceNetwork(loadFixture('rdap/lacnic/ip/200.3.14.10.json'), { rir: 'lacnic' });
    expect(net.prefixes).toEqual(['200.3.12.0/22']);
    expect(net.abuse).toEqual({ personal: true });
    expect(net.tech).toEqual({ personal: true });
  });

  it('AFRINIC 196.216.2.1: org holder, personal tech/admin', () => {
    const net = reduceNetwork(loadFixture('rdap/afrinic/ip/196.216.2.1.json'), { rir: 'afrinic' });
    expect(net.prefixes).toEqual(['196.216.2.0/23']);
    expect(net.holder).toHaveProperty('handle');
    expect(net.tech).toEqual({ personal: true });
    expect(net.admin).toEqual({ personal: true });
  });

  it('APNIC AS4608, ORG-ARAD1-AP, 1.1.1.in-addr.arpa', () => {
    const as = reduceAutnum(loadFixture('rdap/apnic/autnum/4608.json'), { rir: 'apnic' });
    expect([as.asnStart, as.asnEnd]).toEqual([4608, 4608]);
    expect(reduceEntity(loadFixture('rdap/apnic/entity/ORG-ARAD1-AP.json'), { rir: 'apnic' }))
      .toMatchObject({ type: 'entity', kind: 'org', name: 'APNIC Research and Development' });
    expect(reduceDomain(loadFixture('rdap/apnic/domain/1.1.1.in-addr.arpa.json'), { rir: 'apnic' }))
      .toMatchObject({ zone: '1.1.1.in-addr.arpa', nameservers: ['alec.ns.cloudflare.com', 'mira.ns.cloudflare.com'], signed: false });
  });
});
