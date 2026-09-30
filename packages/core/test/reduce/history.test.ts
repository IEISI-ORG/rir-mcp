import { describe, expect, it } from 'vitest';
import { historyChanges, reduceHistory, stateAt } from '../../src/reduce/history';
import { renderHistory } from '../../src/render/history';
import type { Meta } from '../../src/service/answer';
import { loadFixture } from '../support/fixtures';

const meta: Meta = { rir: 'apnic', cache: 'miss', ageS: 0, url: 'https://rdap.apnic.net/history/ip/192.0.2.1' };
const vc = (kind: string, fn: string) => ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', fn], ['kind', {}, 'text', kind]]];
const live = { status: ['active'], country: 'AU', type: 'ASSIGNED PORTABLE' };
const rec = (from: string, until: string | null, content: Record<string, unknown>, cidr = { v4prefix: '192.0.2.0', length: 24 }) => ({
  applicableFrom: `${from}T00:00:00Z`,
  applicableUntil: until ? `${until}T00:00:00Z` : null,
  content: { objectClassName: 'ip network', handle: 'H', cidr0_cidrs: [cidr], ...content },
});

const synthetic = {
  records: [
    rec('2010-01-01', '2011-01-01', { name: 'ALPHA', ...live }),
    rec('2011-01-01', '2011-06-01', { name: 'ALPHA', ...live, remarks: [{ description: ['edit'] }] }),
    rec('2011-06-01', '2011-06-02', {}),
    rec('2011-06-02', '2014-01-01', { name: 'ALPHA', ...live }),
    rec('2014-01-01', '2017-01-01', { name: 'BETA', ...live, entities: [{ handle: 'P-9', roles: ['technical'], vcardArray: vc('individual', 'Jane Doe') }] }),
    rec('2017-01-01', null, { name: 'BETA', ...live, entities: [{ handle: 'ORG-X-AP', roles: ['registrant'], vcardArray: vc('org', 'Example Org') }] }),
    rec('2009-01-01', null, { name: 'COVER', ...live }, { v4prefix: '192.0.0.0', length: 16 }),
  ],
};

describe('reduceHistory (synthetic)', () => {
  const h = reduceHistory(synthetic, { rir: 'apnic', query: '192.0.2.1' });

  it('groups by object, most specific first, and collapses identical states', () => {
    expect(h.objects.map((o) => o.key)).toEqual(['192.0.2.0/24', '192.0.0.0/16']);
    expect(h.objects[0]?.states[0]).toEqual({ from: '2010-01-01', until: '2011-06-01', s: expect.objectContaining({ name: 'ALPHA' }) });
    expect(h.rawRecords).toBe(7);
    expect(h.latestFrom).toBe('2017-01-01');
    expect(JSON.stringify(h)).not.toContain('Jane');
  });

  it('derives summary changes including withdrawal and re-creation', () => {
    const primary = h.objects[0]!;
    expect(historyChanges(primary, 'summary').map((c) => [c.date, c.kind])).toEqual([
      ['2010-01-01', 'created'], ['2011-06-01', 'withdrawn'], ['2011-06-02', 're-created'],
      ['2014-01-01', 'changed'], ['2017-01-01', 'changed'],
    ]);
    expect(historyChanges(primary, 'summary', '2014-01-01')).toHaveLength(2);
    expect(historyChanges(primary, 'full')[3]?.fields).toEqual({ name: 'BETA', tech: 'personal' });
  });

  it('answers point-in-time queries, falling back to covering objects', () => {
    expect(stateAt(h, '2012-01-01')?.row.s?.name).toBe('ALPHA');
    expect(stateAt(h, '2011-06-01')?.row.s).toBeNull();
    expect(stateAt(h, '2009-06-01')?.object.key).toBe('192.0.0.0/16');
    expect(stateAt(h, '2000-01-01')).toBeNull();
  });

  it('renders the summary timeline', () => {
    expect(renderHistory(h, meta, { detail: 'summary' })).toBe([
      '192.0.2.0/24  history (APNIC RDAP, 7 records -> 5 changes)',
      '2010-01-01  created    ALPHA  ASSIGNED PORTABLE  AU  active',
      '2011-06-01  withdrawn',
      '2011-06-02  re-created ALPHA  ASSIGNED PORTABLE  AU  active',
      '2014-01-01  renamed    BETA',
      '2017-01-01  holder     ORG-X-AP (Example Org)',
      'covering    192.0.0.0/16 COVER (since 2009-01-01)',
      'source    APNIC RDAP, fetched just now',
    ].join('\n'));
  });

  it('renders a point-in-time answer', () => {
    const text = renderHistory(h, meta, { detail: 'summary', at: '2012-01-01' });
    expect(text).toContain('192.0.2.1 on 2012-01-01');
    expect(text).toContain('object    192.0.2.0/24  ALPHA');
    expect(text).toContain('valid     2011-06-02 .. 2014-01-01');
  });

  it('rejects responses without records', () => {
    expect(() => reduceHistory({}, { rir: 'apnic', query: 'x' })).toThrow('records');
  });
});

describe('reduceHistory (recorded APNIC fixtures)', () => {
  it('1.1.1.1: provenance of 1.1.1.0/24', () => {
    const h = reduceHistory(loadFixture('rdap/apnic/history-ip/1.1.1.1.json'), { rir: 'apnic', query: '1.1.1.1' });
    const primary = h.objects[0]!;
    expect(primary.key).toBe('1.1.1.0/24');
    const changes = historyChanges(primary, 'summary');
    expect(changes.slice(0, 3).map((c) => c.kind)).toEqual(['created', 'withdrawn', 're-created']);
    expect(changes).toContainEqual(expect.objectContaining({ date: '2014-05-07', fields: expect.objectContaining({ name: 'APNIC-LABS' }) }));
    expect(changes).toContainEqual(expect.objectContaining({ date: '2017-08-29', fields: expect.objectContaining({ holder: 'ORG-ARAD1-AP' }) }));
    expect(h.objects.map((o) => o.key)).toContain('1.0.0.0/8');
    expect(stateAt(h, '2012-01-01')?.row.s?.name).toBe('Debogon-prefix');
    const text = renderHistory(h, { ...meta, url: 'https://rdap.apnic.net/history/ip/1.1.1.1' }, { detail: 'summary' });
    expect(new TextEncoder().encode(text).length).toBeLessThan(1500);
    for (const marker of ['Example Person', 'example.net', '[scrubbed]']) expect(JSON.stringify(h) + text).not.toContain(marker);
    expect(text).toMatchSnapshot();
  });

  it('AS4608 renders under budget', () => {
    const h = reduceHistory(loadFixture('rdap/apnic/history-autnum/4608.json'), { rir: 'apnic', query: 'AS4608' });
    expect(h.objects[0]?.key).toBe('AS4608');
    const text = renderHistory(h, meta, { detail: 'summary' });
    expect(new TextEncoder().encode(text).length).toBeLessThan(1500);
  });
});
