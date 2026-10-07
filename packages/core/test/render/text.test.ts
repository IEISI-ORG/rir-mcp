import { describe, expect, it } from 'vitest';
import { reduceAutnum } from '../../src/reduce/autnum';
import { reduceDomain } from '../../src/reduce/domain';
import { reduceEntity } from '../../src/reduce/entity';
import { reduceNetwork } from '../../src/reduce/network';
import type { EntityRecord, NetworkRecord } from '../../src/reduce/types';
import { renderAutnum, renderDomain, renderEntity, renderNetwork, renderSpecial } from '../../src/render/text';
import type { Meta } from '../../src/service/answer';
import { loadFixture, rdapFixtures, rirOf } from '../support/fixtures';

const URL_A = 'https://rdap.apnic.net/ip/1.1.1.1';
const meta = (cache: Meta['cache'] = 'miss', ageS = 0): Meta => ({ rir: 'apnic', cache, ageS, url: URL_A });

const net: NetworkRecord = {
  type: 'network', rir: 'apnic', handle: '1.1.1.0 - 1.1.1.255', prefixes: ['1.1.1.0/24'], name: 'APNIC-LABS',
  country: 'AU', allocationType: 'ASSIGNED PORTABLE', status: ['active'],
  holder: { handle: 'ORG-ARAD1-AP', name: 'APNIC Research and Development', email: 'helpdesk@apnic.net' },
  abuse: { handle: 'IRT-APNICRANDNET-AU', name: 'IRT-APNICRANDNET-AU', email: 'helpdesk@apnic.net' },
  tech: { handle: 'AIC3-AP', name: 'APNICRANDNET Infrastructure Contact', email: 'research@apnic.net' },
  registered: '2011-08-10', changed: '2023-04-26',
};

describe('renderNetwork', () => {
  it('renders the spec example exactly', () => {
    expect(renderNetwork(net, meta())).toBe([
      'network   1.1.1.0/24  APNIC-LABS  (AU, ASSIGNED PORTABLE, active)',
      'holder    APNIC Research and Development  [ORG-ARAD1-AP]',
      'abuse     helpdesk@apnic.net  [IRT-APNICRANDNET-AU]',
      'tech      research@apnic.net  [AIC3-AP]',
      'dates     registered 2011-08-10, changed 2023-04-26',
      'source    APNIC RDAP, fetched just now',
    ].join('\n'));
  });

  it('never names a personal abuse contact and points to the network record', () => {
    const text = renderNetwork({ ...net, rir: 'lacnic', abuse: { personal: true }, tech: { personal: true } }, { ...meta(), rir: 'lacnic' });
    expect(text).toContain(`abuse     personal contact, not disclosed; see ${URL_A}`);
    expect(text).toContain('tech      personal contact, not disclosed');
    expect(text).toContain('source    LACNIC RDAP');
  });

  it('labels cache age and staleness', () => {
    expect(renderNetwork(net, meta('hit', 180))).toContain('source    APNIC RDAP, cached 3m ago');
    expect(renderNetwork(net, meta('stale', 3 * 3600))).toContain('APNIC RDAP, STALE: fetched 3h ago; could not refresh');
  });
});

describe('other renderers', () => {
  it('renders entity, domain and special answers', () => {
    const ent: EntityRecord = { type: 'entity', rir: 'apnic', handle: 'ORG-ARAD1-AP', kind: 'org', name: 'APNIC Research and Development', email: 'helpdesk@apnic.net', roles: [] };
    expect(renderEntity(ent, meta())).toContain('entity    APNIC Research and Development  [ORG-ARAD1-AP]  (org)');
    const dom = renderDomain({ type: 'domain', rir: 'apnic', zone: '1.1.1.in-addr.arpa', nameservers: ['a.example', 'b.example'], signed: false }, meta());
    expect(dom).toContain('zone      1.1.1.in-addr.arpa');
    expect(dom).toContain('nameservers a.example, b.example');
    expect(dom).toContain('dnssec    not signed (no DS in registry)');
    expect(renderSpecial('10.1.2.3', { name: 'Private-Use', ref: 'RFC 1918' })).toContain('10.1.2.3  Private-Use (RFC 1918)');
  });
});

describe('token budget: every current-record fixture renders under 600 bytes', () => {
  const reducers = { ip: [reduceNetwork, renderNetwork], autnum: [reduceAutnum, renderAutnum], entity: [reduceEntity, renderEntity], domain: [reduceDomain, renderDomain] } as const;
  it.each(rdapFixtures(Object.keys(reducers)))('%s', (rel) => {
    const kind = rel.split('/')[2] as keyof typeof reducers;
    const [reduce, render] = reducers[kind];
    const record = reduce(loadFixture(rel), { rir: rirOf(rel) });
    if (record.type === 'personal-entity') return;
    const text = (render as (r: unknown, m: Meta) => string)(record, { ...meta(), rir: rirOf(rel) });
    expect(new TextEncoder().encode(text).length).toBeLessThan(600);
    expect(text).toMatchSnapshot();
  });
});

describe('token budget for awkward ranges (Task 9 follow-up)', () => {
  it('keeps a network whose range is many CIDR blocks under 600 bytes, even when stale, listing the rest as a count', () => {
    // An ARIN-style range off CIDR boundaries: 63.0.0.1 - 63.255.255.254 is 46 prefixes.
    const raw = { ...(loadFixture('rdap/arin/ip/8.8.8.8.json') as Record<string, unknown>), startAddress: '63.0.0.1', endAddress: '63.255.255.254', cidr0_cidrs: undefined };
    const r = reduceNetwork(raw, { rir: 'arin' });
    expect(r.prefixes.length).toBeGreaterThan(40); // structured output keeps them all
    const text = renderNetwork(r, { ...meta('stale', 3 * 3600), rir: 'arin' });
    expect(new TextEncoder().encode(text).length).toBeLessThan(600);
    expect(text).toContain(`63.0.0.1/32 63.0.0.2/31 63.0.0.4/30 63.0.0.8/29 (+${r.prefixes.length - 4} more)`);
  });
});

