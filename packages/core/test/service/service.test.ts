import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../src/memory/cache';
import { MemoryRateLimiter } from '../../src/memory/rate-limiter';
import type { RateLimiter } from '../../src/ports';
import { DEFAULT_LIMITS } from '../../src/rdap/limits';
import { RirService } from '../../src/service/service';
import { FakeClock } from '../support/fake-clock';
import { fakeFetch, type FakeRoute } from '../support/fake-fetch';
import { ianaRoutes, loadFixture } from '../support/fixtures';

const APNIC = 'https://rdap.apnic.net/';
const IP_URL = `${APNIC}ip/1.1.1.1`;
const HIST_URL = `${APNIC}history/ip/1.1.1.1`;
const HOUR = 3_600_000;

function setup(routes: Record<string, FakeRoute | (() => FakeRoute)> = {}, limiter?: RateLimiter) {
  const fetch = fakeFetch({
    ...ianaRoutes(),
    [IP_URL]: { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
    [HIST_URL]: { body: loadFixture('rdap/apnic/history-ip/1.1.1.1.json') },
    [`${APNIC}autnum/4608`]: { body: loadFixture('rdap/apnic/autnum/4608.json') },
    [`${APNIC}entity/ORG-ARAD1-AP`]: { body: loadFixture('rdap/apnic/entity/ORG-ARAD1-AP.json') },
    [`${APNIC}domain/1.1.1.in-addr.arpa`]: { body: loadFixture('rdap/apnic/domain/1.1.1.in-addr.arpa.json') },
    ...routes,
  });
  const clock = new FakeClock();
  const service = new RirService({
    fetch, clock, userAgent: 'test', cache: new MemoryCache(clock),
    limiter: limiter ?? new MemoryRateLimiter(DEFAULT_LIMITS, clock),
  });
  const rdapCalls = () => fetch.calls.filter((u) => !u.startsWith('https://data.iana.org/'));
  return { fetch, clock, service, rdapCalls };
}

describe('RirService.ip', () => {
  it('fetches once, then serves from cache', async () => {
    const { service, rdapCalls } = setup();
    const a = await service.ip('1.1.1.1');
    expect(a).toMatchObject({ kind: 'record', record: { prefixes: ['1.1.1.0/24'] }, meta: { rir: 'apnic', cache: 'miss', url: IP_URL } });
    expect(await service.ip(' 1.1.1.1 ')).toMatchObject({ kind: 'record', meta: { cache: 'hit' } });
    expect(rdapCalls()).toEqual([IP_URL]);
  });

  it('answers special-purpose space with no network calls at all', async () => {
    const { service, fetch } = setup();
    expect(await service.ip('10.1.2.3')).toMatchObject({ kind: 'special', query: '10.1.2.3', special: { ref: 'RFC 1918' } });
    expect(await service.ip('203.0.113.5')).toMatchObject({ kind: 'special' });
    expect(fetch.calls).toEqual([]);
  });

  it('reports addresses outside every RIR delegation without an RDAP call', async () => {
    const { service, rdapCalls } = setup();
    expect(await service.ip('4000::1')).toMatchObject({ kind: 'error', code: 'not_delegated' });
    expect(rdapCalls()).toEqual([]);
  });

  it('returns invalid_input with an example for bad input', async () => {
    const { service } = setup();
    const a = await service.ip('1.1.1');
    expect(a).toMatchObject({ kind: 'error', code: 'invalid_input' });
    expect(a.kind === 'error' && a.message).toContain('e.g. 1.1.1.1');
  });

  it('caches not-found answers', async () => {
    const { service, rdapCalls } = setup();
    expect(await service.ip('1.1.2.3')).toMatchObject({ kind: 'error', code: 'not_found' });
    expect(await service.ip('1.1.2.3')).toMatchObject({ kind: 'error', code: 'not_found' });
    expect(rdapCalls()).toHaveLength(1);
  });

  it('serves a labelled stale answer when the RIR fails after expiry', async () => {
    let down = false;
    const { service, clock } = setup({ [IP_URL]: () => (down ? { status: 503, text: '' } : { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') }) });
    await service.ip('1.1.1.1');
    clock.advance(2 * HOUR);
    down = true;
    expect(await service.ip('1.1.1.1')).toMatchObject({ kind: 'record', meta: { cache: 'stale', ageS: 7200 } });
  });

  it('never caches an HTML challenge page', async () => {
    // Permissive limiter: the first failure penalises the real one, which would hide the second call.
    const open: RateLimiter = { acquire: async () => ({ ok: true }), penalise: async () => {} };
    const { service, rdapCalls } = setup({ [IP_URL]: { text: '<html>challenge</html>', headers: { 'content-type': 'text/html' } } }, open);
    expect(await service.ip('1.1.1.1')).toMatchObject({ kind: 'error', code: 'upstream' });
    await service.ip('1.1.1.1');
    expect(rdapCalls()).toEqual([IP_URL, IP_URL]);
  });

  it('coalesces a burst of identical questions into one upstream call', async () => {
    const { service, rdapCalls } = setup();
    const answers = await Promise.all(Array.from({ length: 5 }, () => service.ip('1.1.1.1')));
    expect(answers.every((a) => a.kind === 'record')).toBe(true);
    expect(rdapCalls()).toEqual([IP_URL]);
  });

  it('serves stale when the local limiter is exhausted, else reports retry time', async () => {
    let allow = true;
    const limiter: RateLimiter = {
      acquire: async () => (allow ? { ok: true } : { ok: false, retryAfterS: 9 }),
      penalise: async () => {},
    };
    const { service, clock } = setup({}, limiter);
    await service.ip('1.1.1.1');
    clock.advance(2 * HOUR);
    allow = false;
    expect(await service.ip('1.1.1.1')).toMatchObject({ kind: 'record', meta: { cache: 'stale' } });
    expect(await service.asn('4608')).toMatchObject({ kind: 'error', code: 'rate_limited', retryAfterS: 9 });
  });
});

describe('RirService other lookups', () => {
  it('asn accepts messy input and answers special ASNs locally', async () => {
    const { service, rdapCalls } = setup();
    expect(await service.asn(' AS 4608 ')).toMatchObject({ kind: 'record', record: { asnStart: 4608 }, meta: { url: `${APNIC}autnum/4608` } });
    expect(await service.asn('64512')).toMatchObject({ kind: 'special', query: 'AS64512' });
    expect(rdapCalls()).toEqual([`${APNIC}autnum/4608`]);
  });

  it('entity infers the RIR from the handle suffix or asks for it', async () => {
    const { service } = setup();
    expect(await service.entity('org-arad1-ap')).toMatchObject({ kind: 'record', record: { kind: 'org' } });
    const a = await service.entity('IRT-APNICRANDNET-AU');
    expect(a).toMatchObject({ kind: 'error', code: 'invalid_input' });
    expect(a.kind === 'error' && a.message).toContain('rir');
  });

  it('entity refuses personal records without echoing their data', async () => {
    const person = { objectClassName: 'entity', handle: 'EXAMPLE-PERSON-1-AP', vcardArray: ['vcard', [['fn', {}, 'text', 'Example Person 1'], ['kind', {}, 'text', 'individual']]] };
    const { service } = setup({ [`${APNIC}entity/EXAMPLE-PERSON-1-AP`]: { body: person } });
    const a = await service.entity('EXAMPLE-PERSON-1-AP');
    expect(a).toMatchObject({ kind: 'error', code: 'personal_record' });
    expect(JSON.stringify(a)).not.toContain('Example Person');
  });

  it('reverseDns returns the delegation, walking up zones on 404', async () => {
    const { service, rdapCalls } = setup();
    expect(await service.reverseDns('1.1.1.1')).toMatchObject({ kind: 'record', record: { zone: '1.1.1.in-addr.arpa' } });
    const miss = await service.reverseDns('1.1.2.3');
    expect(miss).toMatchObject({ kind: 'error', code: 'not_found' });
    expect(rdapCalls()).toEqual([
      `${APNIC}domain/1.1.1.in-addr.arpa`,
      `${APNIC}domain/2.1.1.in-addr.arpa`, `${APNIC}domain/1.1.in-addr.arpa`, `${APNIC}domain/1.in-addr.arpa`,
    ]);
  });
});

describe('RirService.history', () => {
  it('returns APNIC history and refuses other RIRs without calling them', async () => {
    const { service, rdapCalls } = setup();
    expect(await service.history({ resource: '1.1.1.1' })).toMatchObject({ kind: 'record', record: { type: 'history' } });
    expect(await service.history({ resource: '8.8.8.8' })).toMatchObject({ kind: 'error', code: 'history_unavailable' });
    expect(rdapCalls().filter((u) => u.includes('/history/'))).toEqual([HIST_URL]);
  });

  it('re-uses cached history until the object changes after the newest record', async () => {
    let changed = '2023-04-26T22:57:58Z';
    const current = () => {
      const doc = loadFixture('rdap/apnic/ip/1.1.1.1.json') as { events: Array<{ eventAction: string; eventDate: string }> };
      return { body: { ...doc, events: doc.events.map((e) => (e.eventAction === 'last changed' ? { ...e, eventDate: changed } : e)) } };
    };
    const { service, clock, rdapCalls } = setup({ [IP_URL]: current });
    await service.history({ resource: '1.1.1.1' });
    clock.advance(2 * HOUR);
    await service.history({ resource: '1.1.1.1' });
    expect(rdapCalls().filter((u) => u === HIST_URL)).toHaveLength(1);
    changed = '2099-01-01T00:00:00Z';
    clock.advance(2 * HOUR);
    await service.history({ resource: '1.1.1.1' });
    expect(rdapCalls().filter((u) => u === HIST_URL)).toHaveLength(2);
    clock.advance(2 * HOUR);
    await service.history({ resource: '1.1.1.1' });
    expect(rdapCalls().filter((u) => u === HIST_URL)).toHaveLength(2);
  });

  it('answers cold history for a not-found entity on a full bucket at the first call', async () => {
    const entity = loadFixture('rdap/apnic/entity/ORG-ARAD1-AP.json');
    const { service } = setup({
      [`${APNIC}history/entity/ORG-GONE1-AP`]: {
        body: { records: [{ applicableFrom: '2020-01-01T00:00:00Z', applicableUntil: null, content: entity }] },
      },
    });
    expect(await service.history({ resource: 'ORG-GONE1-AP', type: 'entity' })).toMatchObject({ kind: 'record' });
  });

  it('answers cold entity history on a full bucket at the first call', async () => {
    const entity = loadFixture('rdap/apnic/entity/ORG-ARAD1-AP.json');
    const { service } = setup({
      [`${APNIC}history/entity/ORG-ARAD1-AP`]: {
        body: { records: [{ applicableFrom: '2020-01-01T00:00:00Z', applicableUntil: null, content: entity }] },
      },
    });
    expect(await service.history({ resource: 'ORG-ARAD1-AP', type: 'entity' })).toMatchObject({ kind: 'record' });
  });

  it('infers the resource type', async () => {
    const { inferHistoryType } = await import('../../src/service/service');
    expect(inferHistoryType('1.1.1.1')).toBe('ip');
    expect(inferHistoryType('AS4608')).toBe('asn');
    expect(inferHistoryType('4608')).toBe('asn');
    expect(inferHistoryType('ORG-ARAD1-AP')).toBe('entity');
  });
});

describe('RirService.history personal records (audit 2026-10-03)', () => {
  it('refuses the history of a deleted personal entity and caches nothing personal', async () => {
    const person = {
      objectClassName: 'entity', handle: 'JD1-AP', status: ['active'],
      vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Person'], ['kind', {}, 'text', 'individual']]],
    };
    const { service } = setup({
      [`${APNIC}entity/JD1-AP`]: { status: 404, text: '{}' },
      [`${APNIC}history/entity/JD1-AP`]: { body: { records: [
        { applicableFrom: '2008-03-01T00:00:00Z', applicableUntil: '2019-06-01T00:00:00Z', content: person },
      ] } },
    });
    const a = await service.history({ resource: 'JD1-AP', type: 'entity' });
    expect(a).toMatchObject({ kind: 'error', code: 'personal_record' });
    expect(JSON.stringify(a)).not.toMatch(/2008|2019|Example Person/);
  });
});

describe('RirService upstream failures', () => {
  const spy = () => {
    const penalised: string[] = [];
    const limiter: RateLimiter = { acquire: async () => ({ ok: true }), penalise: async (r) => { penalised.push(r); } };
    return { limiter, penalised };
  };

  it.each([
    ['503', { status: 503, text: '' }],
    ['403', { status: 403, text: 'forbidden' }],
    ['HTML 200', { text: '<html>challenge</html>', headers: { 'content-type': 'text/html' } }],
  ] as Array<[string, FakeRoute]>)('penalises the limiter on %s', async (_name, route) => {
    const { limiter, penalised } = spy();
    const { service } = setup({ [IP_URL]: route }, limiter);
    expect(await service.ip('1.1.1.1')).toMatchObject({ kind: 'error' });
    expect(penalised).toContain('apnic');
  });

  it('serves stale on a challenge page', async () => {
    let challenge = false;
    const { service, clock } = setup({
      [IP_URL]: () => (challenge ? { text: '<html>c</html>', headers: { 'content-type': 'text/html' } } : { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') }),
    });
    await service.ip('1.1.1.1');
    clock.advance(2 * HOUR);
    challenge = true;
    expect(await service.ip('1.1.1.1')).toMatchObject({ kind: 'record', meta: { cache: 'stale' } });
  });
});

describe('RirService cross-RIR redirect', () => {
  const ARIN_URL = 'https://rdap.arin.net/registry/ip/8.8.8.8';
  const APNIC_8 = `${APNIC}ip/8.8.8.8`;
  const redirectRoutes = (): Record<string, FakeRoute> => ({
    [ARIN_URL]: { status: 302, headers: { location: APNIC_8 } },
    [APNIC_8]: { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
    [`${APNIC}history/ip/8.8.8.8`]: { body: loadFixture('rdap/apnic/history-ip/1.1.1.1.json') },
  });
  const spy = (deny?: string) => {
    const acquired: string[] = [];
    const penalised: string[] = [];
    const limiter: RateLimiter = {
      acquire: async (r) => { acquired.push(r); return r === deny ? { ok: false, retryAfterS: 7 } : { ok: true }; },
      penalise: async (r) => { penalised.push(r); },
    };
    return { limiter, acquired, penalised };
  };

  it('attributes the answer to the RIR that served it and bills both buckets', async () => {
    const { limiter, acquired } = spy();
    const { service } = setup(redirectRoutes(), limiter);
    const a = await service.ip('8.8.8.8');
    expect(a).toMatchObject({ kind: 'record', record: { rir: 'apnic' }, meta: { rir: 'apnic', url: APNIC_8 } });
    expect(acquired).toEqual(['arin', 'apnic']);
    const { renderNetwork } = await import('../../src/render/text');
    expect(a.kind === 'record' && renderNetwork(a.record, a.meta)).toContain('APNIC RDAP, fetched just now');
    expect(await service.ip('8.8.8.8')).toMatchObject({ meta: { rir: 'apnic', cache: 'hit', url: APNIC_8 } });
  });

  it('reports rate_limited without penalising when the target bucket is empty', async () => {
    const { limiter, penalised } = spy('apnic');
    const { service } = setup(redirectRoutes(), limiter);
    const a = await service.ip('8.8.8.8');
    expect(a).toMatchObject({ kind: 'error', code: 'rate_limited', retryAfterS: 7 });
    expect(a.kind === 'error' && a.message).toContain('APNIC');
    expect(penalised).toEqual([]);
  });

  it('serves APNIC history when the ARIN route redirects to APNIC', async () => {
    const { service } = setup(redirectRoutes());
    expect(await service.history({ resource: '8.8.8.8' })).toMatchObject({ kind: 'record', record: { type: 'history' } });
  });
});
