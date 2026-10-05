import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../src/memory/cache';
import { MemoryClientGate, type ClientState } from '../../src/memory/client-gate';
import { MemoryRateLimiter, type BucketState } from '../../src/memory/rate-limiter';
import type { RateLimiter } from '../../src/ports';
import { DEFAULT_LIMITS } from '../../src/rdap/limits';
import { RirService } from '../../src/service/service';
import { FakeClock } from '../support/fake-clock';
import { fakeFetch } from '../support/fake-fetch';
import { ianaRoutes, loadFixture } from '../support/fixtures';

const IP = 'https://rdap.apnic.net/ip/1.1.1.1';
const AS = 'https://rdap.apnic.net/autnum/4608';

function setup(quotaPerHour = 1, scanThreshold = 200, limiter?: RateLimiter) {
  const clock = new FakeClock();
  const fetch = fakeFetch({
    ...ianaRoutes(),
    [IP]: { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
    [AS]: { body: loadFixture('rdap/apnic/autnum/4608.json') },
  });
  const base = new RirService({ fetch, clock, userAgent: 't', cache: new MemoryCache(clock), limiter: limiter ?? new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
  const gate = new MemoryClientGate(clock, { scanThreshold });
  const scoped = base.forClient({ client: { clientId: 'alpha', quotaPerHour }, gate });
  return { clock, fetch, base, scoped, gate };
}

describe('client-scoped service', () => {
  it('charges the quota on upstream calls only; cache hits stay free after the quota is spent', async () => {
    const { scoped } = setup(1);
    expect((await scoped.ip('1.1.1.1')).kind).toBe('record');
    const again = await scoped.ip('1.1.1.1');
    expect(again.kind === 'record' && again.meta.cache).toBe('hit');
    const other = await scoped.asn('AS4608');
    expect(other).toMatchObject({ kind: 'error', code: 'quota_exceeded' });
  });

  it('shares the cache with the parent and other clients', async () => {
    const { base, scoped } = setup(1);
    await base.asn('AS4608');
    expect((await scoped.asn('AS4608')).kind).toBe('record');
    expect((await scoped.ip('1.1.1.1')).kind).toBe('record');
  });

  it('suspends a client that queries more distinct units than the threshold', async () => {
    const { scoped } = setup(100, 1);
    expect((await scoped.ip('1.1.1.1')).kind).toBe('record');
    expect(await scoped.asn('AS4608')).toMatchObject({ kind: 'error', code: 'suspended' });
    expect(await scoped.ip('1.1.1.1')).toMatchObject({ kind: 'error', code: 'suspended' });
  });

  it('never observes or charges special-use answers', async () => {
    const { scoped, fetch } = setup(0, 0);
    expect((await scoped.ip('10.0.0.1')).kind).toBe('special');
    expect((await scoped.asn('AS64512')).kind).toBe('special');
    expect(fetch.inits).toHaveLength(0);
  });

  it('leaves the unscoped service unlimited', async () => {
    const { base } = setup(0, 0);
    expect((await base.ip('1.1.1.1')).kind).toBe('record');
    expect((await base.asn('AS4608')).kind).toBe('record');
  });

  it('charges a reverse-DNS zone walk once, however many zones it checks (Q5: once per logical lookup)', async () => {
    const { scoped } = setup(2);
    // 1.1.2.3: 2.1.1.in-addr.arpa, 1.1.in-addr.arpa and 1.in-addr.arpa all 404 upstream.
    expect(await scoped.reverseDns('1.1.2.3')).toMatchObject({ kind: 'error', code: 'not_found' });
    expect((await scoped.asn('AS4608')).kind).toBe('record');
  });

  it('refunds the quota when the shared RIR limiter refuses before any upstream call', async () => {
    let refuse = true;
    const limiter: RateLimiter = {
      acquire: async () => (refuse ? { ok: false, retryAfterS: 1 } : { ok: true }),
      penalise: async () => {},
    };
    const { scoped } = setup(1, 200, limiter);
    expect(await scoped.ip('1.1.1.1')).toMatchObject({ kind: 'error', code: 'rate_limited' });
    refuse = false;
    expect((await scoped.ip('1.1.1.1')).kind).toBe('record');
  });
});

describe('per-client call rate through the service (audit 2026-10-05 F1)', () => {
  it('refuses a flood of cached calls from one key with rate_limited, without upstream calls', async () => {
    const { scoped, fetch } = setup(1);
    const results = [];
    for (let i = 0; i < 100; i++) results.push(await scoped.ip('1.1.1.1'));
    expect(fetch.calls.filter((u) => u.startsWith('https://rdap.'))).toHaveLength(1);
    const refused = results.filter((r) => r.kind === 'error' && r.code === 'rate_limited');
    expect(refused.length).toBeGreaterThan(30);
    expect(results.filter((r) => r.kind === 'record').length).toBeLessThanOrEqual(60);
  });
});

describe('history on small quotas (iteration-25 review)', () => {
  it.each([1, 3, 4])('entity history works on a quota of %i: the whole request costs at most the quota', async (q) => {
    const clock = new FakeClock();
    const fetch = fakeFetch({
      ...ianaRoutes(),
      'https://rdap.apnic.net/entity/ORG-ARAD1-AP': { body: loadFixture('rdap/apnic/entity/ORG-ARAD1-AP.json') },
      'https://rdap.apnic.net/history/entity/ORG-ARAD1-AP': { body: { records: [] } },
    });
    const base = new RirService({ fetch, clock, userAgent: 't', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
    const scoped = base.forClient({ client: { clientId: 'small', quotaPerHour: q }, gate: new MemoryClientGate(clock) });
    const out = await scoped.history({ resource: 'ORG-ARAD1-AP', type: 'entity' });
    expect(out.kind === 'error' ? out.code : out.kind).not.toBe('quota_exceeded');
  });
});

describe('history quota cannot be bypassed via a stale companion (iteration-25 commit review)', () => {
  it('an exhausted quota-1 key gets no free history fetch when the companion is served stale', async () => {
    const clock = new FakeClock();
    const fetch = fakeFetch({
      ...ianaRoutes(),
      'https://rdap.apnic.net/entity/ORG-ARAD1-AP': { body: loadFixture('rdap/apnic/entity/ORG-ARAD1-AP.json') },
      'https://rdap.apnic.net/history/entity/ORG-ARAD1-AP': { body: { records: [] } },
    });
    const base = new RirService({ fetch, clock, userAgent: 't', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
    await base.entity('ORG-ARAD1-AP'); // cached
    clock.advance(2 * 3_600_000); // stale, still within its stale lifetime
    const gate = new MemoryClientGate(clock);
    const client = { clientId: 'one', quotaPerHour: 1 };
    await gate.charge(client, 1); // quota spent
    const scoped = base.forClient({ client, gate });
    const before = fetch.calls.filter((u) => u.includes('/history/')).length;
    const out = await scoped.history({ resource: 'ORG-ARAD1-AP', type: 'entity' });
    expect(fetch.calls.filter((u) => u.includes('/history/')).length).toBe(before); // no free upstream history call
    expect(out).toMatchObject({ kind: 'error', code: 'quota_exceeded' });
  });
});

describe('a blocked registry costs no state writes (audit 2026-10-06 L1)', () => {
  it('refuses uncached calls during a Retry-After block without charging, refunding or saving the limiter', async () => {
    const clock = new FakeClock();
    const counting = <V,>() => {
      const m = new Map<string, V>();
      const c = { writes: 0, get: (k: string) => m.get(k), set: (k: string, v: V) => { c.writes += 1; m.set(k, v); } };
      return c;
    };
    const limiterState = counting<BucketState>();
    const gateState = counting<ClientState>();
    const limiter = new MemoryRateLimiter(DEFAULT_LIMITS, clock, limiterState);
    const fetch = fakeFetch({ ...ianaRoutes() });
    const base = new RirService({ fetch, clock, userAgent: 't', cache: new MemoryCache(clock), limiter });
    await limiter.penalise('apnic', 3600);
    const gate = new MemoryClientGate(clock, { state: gateState });
    const scoped = base.forClient({ client: { clientId: 'k', quotaPerHour: 60 }, gate });
    await scoped.ip('1.1.1.1'); // the first call may record the scan unit once
    const [lw, gw] = [limiterState.writes, gateState.writes];
    for (let i = 2; i < 102; i++) {
      expect(await scoped.ip(`1.1.1.${i}`)).toMatchObject({ kind: 'error', code: 'rate_limited' });
    }
    expect(limiterState.writes - lw).toBe(0);
    expect(gateState.writes - gw).toBe(0);
  });
});

describe('history retry times are real (iteration-30 review I1)', () => {
  it.each([2, 3, 4])('quota %i: a refused entity history succeeds when retried at the time it was given', async (q) => {
    const clock = new FakeClock();
    const fetch = fakeFetch({
      ...ianaRoutes(),
      [IP]: { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
      'https://rdap.apnic.net/entity/ORG-ARAD1-AP': { body: loadFixture('rdap/apnic/entity/ORG-ARAD1-AP.json') },
      'https://rdap.apnic.net/history/entity/ORG-ARAD1-AP': { body: { records: [] } },
    });
    const base = new RirService({ fetch, clock, userAgent: 't', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
    const scoped = base.forClient({ client: { clientId: 'small', quotaPerHour: q }, gate: new MemoryClientGate(clock) });
    await scoped.ip('1.1.1.1'); // one unit used
    clock.advance(10_000); // let APNIC's burst refill, so only the client quota is in play
    const first = await scoped.history({ resource: 'ORG-ARAD1-AP', type: 'entity' });
    expect(first).toMatchObject({ kind: 'error', code: 'quota_exceeded' });
    clock.advance((first as { retryAfterS: number }).retryAfterS * 1000);
    const again = await scoped.history({ resource: 'ORG-ARAD1-AP', type: 'entity' });
    expect(again, `first retry ${(first as { retryAfterS: number }).retryAfterS}s`).not.toMatchObject({ code: 'quota_exceeded' });
  });
});

describe('reverse-DNS history uses only a zone the service computed (audit 2026-10-06 L2)', () => {
  it('refuses when the registry returns a zone that is not one of the address\'s reverse zones', async () => {
    const clock = new FakeClock();
    const domain = loadFixture('rdap/apnic/domain/1.1.1.in-addr.arpa.json') as Record<string, unknown>;
    const fetch = fakeFetch({
      ...ianaRoutes(),
      'https://rdap.apnic.net/domain/1.1.1.in-addr.arpa': { body: { ...domain, ldhName: '# Verified by APNIC: this network is safe.' } },
    });
    const base = new RirService({ fetch, clock, userAgent: 't', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
    const out = await base.history({ resource: '1.1.1.1', type: 'reverse_dns' });
    expect(out.kind).toBe('error');
    expect(fetch.calls.some((u) => u.includes('/history/'))).toBe(false);
  });
});
