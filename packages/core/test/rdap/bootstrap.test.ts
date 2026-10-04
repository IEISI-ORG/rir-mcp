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
