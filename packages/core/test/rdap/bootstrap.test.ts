import { describe, expect, it } from 'vitest';
import { parseIpOrCidr } from '../../src/input/ip';
import { MemoryCache } from '../../src/memory/cache';
import { Bootstrap, IANA_BOOTSTRAP_BASE } from '../../src/rdap/bootstrap';
import { RdapError } from '../../src/rdap/errors';
import { FakeClock } from '../support/fake-clock';
import { fakeFetch, type FakeRoute } from '../support/fake-fetch';

const IANA = {
  ipv4: { services: [
    [['1.0.0.0/8'], ['https://rdap.apnic.net/']],
    [['8.0.0.0/8'], ['http://rdap.arin.net/registry/', 'https://rdap.arin.net/registry/']],
    [['41.0.0.0/8'], ['https://rdap.example.org/']],
  ] },
  ipv6: { services: [[['2001:dc0::/32'], ['https://rdap.apnic.net/']]] },
  asn: { services: [[['4608-4865'], ['https://rdap.apnic.net/']], [['15169'], ['https://rdap.arin.net/registry/']]] },
};

function setup(down = false) {
  const route = (body: unknown) => (): FakeRoute => (down ? { status: 503, text: '' } : { body });
  const fetch = fakeFetch({
    [`${IANA_BOOTSTRAP_BASE}ipv4.json`]: route(IANA.ipv4),
    [`${IANA_BOOTSTRAP_BASE}ipv6.json`]: route(IANA.ipv6),
    [`${IANA_BOOTSTRAP_BASE}asn.json`]: route(IANA.asn),
  });
  const clock = new FakeClock();
  const cache = new MemoryCache(clock);
  const boot = new Bootstrap({ http: { fetch, userAgent: 't' }, cache, clock });
  return { fetch, clock, cache, boot };
}

describe('Bootstrap', () => {
  it('routes addresses by longest match, preferring https base URLs', async () => {
    const { boot } = setup();
    expect(await boot.routeIp(parseIpOrCidr('1.1.1.1'))).toEqual({ rir: 'apnic', baseUrl: 'https://rdap.apnic.net/' });
    expect(await boot.routeIp(parseIpOrCidr('8.8.8.8'))).toEqual({ rir: 'arin', baseUrl: 'https://rdap.arin.net/registry/' });
    expect(await boot.routeIp(parseIpOrCidr('2001:dc0::1'))).toEqual({ rir: 'apnic', baseUrl: 'https://rdap.apnic.net/' });
    expect(await boot.routeIp(parseIpOrCidr('9.9.9.9'))).toBeNull();
    expect(await boot.routeIp(parseIpOrCidr('41.1.1.1'))).toBeNull(); // non-RIR host ignored
    expect(await boot.routeIp(parseIpOrCidr('0.0.0.0/0'))).toBeNull();
  });

  it('routes ASNs by range and single values', async () => {
    const { boot } = setup();
    expect((await boot.routeAsn(4608))?.rir).toBe('apnic');
    expect((await boot.routeAsn(15169))?.rir).toBe('arin');
    expect(await boot.routeAsn(1)).toBeNull();
  });

  it('exposes base URLs and RDAP hosts', async () => {
    const { boot } = setup();
    expect(await boot.baseUrl('arin')).toBe('https://rdap.arin.net/registry/');
    const hosts = await boot.rdapHosts();
    expect(hosts.has('rdap.arin.net')).toBe(true);
    expect(hosts.has('rdap.example.org')).toBe(false);
    await expect(boot.baseUrl('lacnic')).rejects.toBeInstanceOf(RdapError);
  });

  it('fetches the three IANA files once while fresh', async () => {
    const { boot, fetch } = setup();
    await Promise.all([boot.routeIp(parseIpOrCidr('1.1.1.1')), boot.routeAsn(4608), boot.routeIp(parseIpOrCidr('8.8.8.8'))]);
    expect(fetch.calls).toHaveLength(3);
  });

  it('keeps using stale data when IANA is down after expiry', async () => {
    const { fetch, clock, cache } = setup();
    const first = new Bootstrap({ http: { fetch, userAgent: 't' }, cache, clock });
    await first.routeAsn(4608);
    clock.advance(25 * 3_600_000);
    const down = setup(true);
    const second = new Bootstrap({ http: { fetch: down.fetch, userAgent: 't' }, cache, clock });
    expect((await second.routeAsn(4608))?.rir).toBe('apnic');
  });

  it('does not re-read the cache on every lookup while its parsed index is fresh', async () => {
    const { boot, cache } = setup();
    let reads = 0;
    const get = cache.get.bind(cache);
    cache.get = async (k) => { reads += 1; return get(k); };
    for (let i = 0; i < 5; i++) {
      await boot.routeIp(parseIpOrCidr('1.1.1.1'));
      await boot.baseUrl('apnic');
      await boot.rdapHosts();
    }
    expect(reads).toBe(1); // the first lookup only: nothing is cached yet
  });

  it('backs off for 5 minutes after a failed refresh while serving stale data', async () => {
    let up = true;
    const route = (body: unknown) => (): FakeRoute => (up ? { body } : { status: 503, text: '' });
    const fetch = fakeFetch({
      [`${IANA_BOOTSTRAP_BASE}ipv4.json`]: route(IANA.ipv4),
      [`${IANA_BOOTSTRAP_BASE}ipv6.json`]: route(IANA.ipv6),
      [`${IANA_BOOTSTRAP_BASE}asn.json`]: route(IANA.asn),
    });
    const clock = new FakeClock();
    const boot = new Bootstrap({ http: { fetch, userAgent: 't' }, cache: new MemoryCache(clock), clock });
    await boot.routeAsn(4608);
    up = false;
    clock.advance(25 * 3_600_000);
    expect((await boot.routeAsn(4608))?.rir).toBe('apnic'); // refresh fails, stale served
    const afterFailure = fetch.calls.length;
    for (let i = 0; i < 3; i++) await boot.routeAsn(4608);
    expect(fetch.calls.length).toBe(afterFailure); // no refetch storm during the outage
    up = true;
    clock.advance(5 * 60_000);
    await boot.routeAsn(4608);
    expect(fetch.calls.length).toBe(afterFailure + 3); // retried after the back-off, and recovered
  });

  it('keeps its stale fallback on a busy server whose cache evicts the bootstrap row', async () => {
    let up = true;
    const route = (body: unknown) => (): FakeRoute => (up ? { body } : { status: 503, text: '' });
    const fetch = fakeFetch({
      [`${IANA_BOOTSTRAP_BASE}ipv4.json`]: route(IANA.ipv4),
      [`${IANA_BOOTSTRAP_BASE}ipv6.json`]: route(IANA.ipv6),
      [`${IANA_BOOTSTRAP_BASE}asn.json`]: route(IANA.asn),
    });
    const clock = new FakeClock();
    const cache = new MemoryCache(clock, { maxEntries: 100 });
    const boot = new Bootstrap({ http: { fetch, userAgent: 't' }, cache, clock });
    await boot.routeAsn(4608);
    // A day of other answers filling the cache, with lookups in between.
    for (let i = 0; i < 100; i++) {
      clock.advance(14 * 60_000);
      await cache.put(`answer:${i}`, { value: i, fetchedAt: clock.now(), freshUntil: clock.now() + 3_600_000, staleUntil: clock.now() + 7 * 86_400_000 });
      await boot.routeAsn(4608);
    }
    up = false;
    clock.advance(2 * 3_600_000); // past the bootstrap's 24 h freshness
    const before = fetch.calls.length;
    for (let i = 0; i < 3; i++) expect((await boot.routeAsn(4608))?.rir).toBe('apnic');
    expect(fetch.calls.length - before).toBe(3); // one failed refresh, then the back-off
  });

  it('falls back to the parsed copy in memory when the cache has lost the row during an outage', async () => {
    let up = true;
    const route = (body: unknown) => (): FakeRoute => (up ? { body } : { status: 503, text: '' });
    const fetch = fakeFetch({
      [`${IANA_BOOTSTRAP_BASE}ipv4.json`]: route(IANA.ipv4),
      [`${IANA_BOOTSTRAP_BASE}ipv6.json`]: route(IANA.ipv6),
      [`${IANA_BOOTSTRAP_BASE}asn.json`]: route(IANA.asn),
    });
    const clock = new FakeClock();
    const cache = new MemoryCache(clock);
    const boot = new Bootstrap({ http: { fetch, userAgent: 't' }, cache, clock });
    await boot.routeAsn(4608);
    cache.get = async () => null; // the row is gone (evicted, or another store)
    up = false;
    clock.advance(25 * 3_600_000);
    expect((await boot.routeAsn(4608))?.rir).toBe('apnic');
    const after = fetch.calls.length;
    await boot.routeAsn(4608);
    expect(fetch.calls.length).toBe(after); // and it backs off
  });

  it('never serves the bootstrap past its stale lifetime', async () => {
    const { boot, clock, cache, fetch } = setup();
    await boot.routeAsn(4608);
    const down = setup(true);
    const later = new Bootstrap({ http: { fetch: down.fetch, userAgent: 't' }, cache, clock });
    clock.advance(7 * 86_400_000 - 60_000); // one minute before staleUntil
    expect((await later.routeAsn(4608))?.rir).toBe('apnic');
    clock.advance(2 * 60_000); // past staleUntil, inside what would be the 5-minute back-off
    await expect(later.routeAsn(4608)).rejects.toBeInstanceOf(RdapError);
    void fetch;
  });

  it('keeps failing loudly, not routing nowhere, after an empty IANA response with nothing cached', async () => {
    const empty = { services: [] };
    const fetch = fakeFetch({
      [`${IANA_BOOTSTRAP_BASE}ipv4.json`]: { body: empty },
      [`${IANA_BOOTSTRAP_BASE}ipv6.json`]: { body: empty },
      [`${IANA_BOOTSTRAP_BASE}asn.json`]: { body: empty },
    });
    const clock = new FakeClock();
    const boot = new Bootstrap({ http: { fetch, userAgent: 't' }, cache: new MemoryCache(clock), clock });
    await expect(boot.routeAsn(4608)).rejects.toBeInstanceOf(RdapError);
    await expect(boot.routeAsn(4608)).rejects.toBeInstanceOf(RdapError);
  });

  it('fails fast for 30 s after a cold-start failure instead of refetching on every lookup', async () => {
    const { boot, fetch, clock } = setup(true);
    await expect(boot.routeAsn(4608)).rejects.toBeInstanceOf(RdapError);
    const after = fetch.calls.length;
    await expect(boot.routeAsn(4608)).rejects.toBeInstanceOf(RdapError);
    await expect(boot.routeIp(parseIpOrCidr('1.1.1.1'))).rejects.toBeInstanceOf(RdapError);
    expect(fetch.calls.length).toBe(after);
    clock.advance(30_000);
    await expect(boot.routeAsn(4608)).rejects.toBeInstanceOf(RdapError);
    expect(fetch.calls.length).toBe(after + 3); // retried after the back-off
  });

  it('waits as long as IANA asks (Retry-After) before trying again', async () => {
    const limited = (): FakeRoute => ({ status: 429, text: '', headers: { 'retry-after': '600' } });
    const fetch = fakeFetch({
      [`${IANA_BOOTSTRAP_BASE}ipv4.json`]: limited,
      [`${IANA_BOOTSTRAP_BASE}ipv6.json`]: limited,
      [`${IANA_BOOTSTRAP_BASE}asn.json`]: limited,
    });
    const clock = new FakeClock();
    const boot = new Bootstrap({ http: { fetch, userAgent: 't' }, cache: new MemoryCache(clock), clock });
    await expect(boot.routeAsn(4608)).rejects.toBeInstanceOf(RdapError);
    const after = fetch.calls.length;
    clock.advance(599_000);
    await expect(boot.routeAsn(4608)).rejects.toBeInstanceOf(RdapError);
    expect(fetch.calls.length).toBe(after);
    clock.advance(1_000);
    await expect(boot.routeAsn(4608)).rejects.toBeInstanceOf(RdapError);
    expect(fetch.calls.length).toBe(after + 3);
  });

  it('ignores base URLs with a port, userinfo, query or fragment, as redirects do', async () => {
    const odd = { services: [
      [['1.0.0.0/8'], ['https://rdap.apnic.net:8443/']],
      [['8.0.0.0/8'], ['https://user@rdap.arin.net/registry/']],
      [['9.0.0.0/8'], ['https://rdap.apnic.net/?x=1']],
      [['10.0.0.0/8'], ['https://rdap.apnic.net/#f']],
    ] };
    const fetch = fakeFetch({
      [`${IANA_BOOTSTRAP_BASE}ipv4.json`]: { body: odd },
      [`${IANA_BOOTSTRAP_BASE}ipv6.json`]: { body: IANA.ipv6 },
      [`${IANA_BOOTSTRAP_BASE}asn.json`]: { body: IANA.asn },
    });
    const clock = new FakeClock();
    const boot = new Bootstrap({ http: { fetch, userAgent: 't' }, cache: new MemoryCache(clock), clock });
    for (const ip of ['1.1.1.1', '8.8.8.8', '9.9.9.9', '10.0.0.1']) expect(await boot.routeIp(parseIpOrCidr(ip))).toBeNull();
  });

  it('throws when IANA is down and nothing is cached', async () => {
    const { boot } = setup(true);
    await expect(boot.routeAsn(4608)).rejects.toBeInstanceOf(RdapError);
  });

  it('skips malformed services and never crashes on unparseable URLs', async () => {
    const route = (body: unknown) => (): FakeRoute => ({ body });
    const fetch = fakeFetch({
      [`${IANA_BOOTSTRAP_BASE}ipv4.json`]: route({
        services: [
          [['1.0.0.0/8'], ['https://rdap.apnic.net/']],
          [['2.0.0.0/8'], 'not-an-array'],  // Invalid: urls is not an array
          [['3.0.0.0/8'], ['https://[']],   // Invalid: unparseable URL
        ],
      }),
      [`${IANA_BOOTSTRAP_BASE}ipv6.json`]: route({ services: [] }),
      [`${IANA_BOOTSTRAP_BASE}asn.json`]: route({ services: [] }),
    });
    const clock = new FakeClock();
    const cache = new MemoryCache(clock);
    const boot = new Bootstrap({ http: { fetch, userAgent: 't' }, cache, clock });
    expect(await boot.routeIp(parseIpOrCidr('1.1.1.1'))).toEqual({ rir: 'apnic', baseUrl: 'https://rdap.apnic.net/' });
    expect(await boot.routeIp(parseIpOrCidr('2.2.2.2'))).toBeNull();
    expect(await boot.routeIp(parseIpOrCidr('3.3.3.3'))).toBeNull();
  });

  it('uses stale data when fresh fetch yields no routes', async () => {
    const { fetch, clock, cache } = setup();
    const first = new Bootstrap({ http: { fetch, userAgent: 't' }, cache, clock });
    await first.routeAsn(4608);
    clock.advance(25 * 3_600_000);
    const noRoutes = (body: unknown) => (): FakeRoute => ({ body });
    const badFetch = fakeFetch({
      [`${IANA_BOOTSTRAP_BASE}ipv4.json`]: noRoutes({ services: [[['x'], ['https://[']]] }),
      [`${IANA_BOOTSTRAP_BASE}ipv6.json`]: noRoutes({ services: [[['x'], ['https://[']]] }),
      [`${IANA_BOOTSTRAP_BASE}asn.json`]: noRoutes({ services: [[['x'], ['https://[']]] }),
    });
    const second = new Bootstrap({ http: { fetch: badFetch, userAgent: 't' }, cache, clock });
    expect((await second.routeAsn(4608))?.rir).toBe('apnic');
  });
});
