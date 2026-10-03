import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../src/memory/cache';
import { MemoryClientGate } from '../../src/memory/client-gate';
import { MemoryRateLimiter } from '../../src/memory/rate-limiter';
import { DEFAULT_LIMITS } from '../../src/rdap/limits';
import { RirService } from '../../src/service/service';
import { FakeClock } from '../support/fake-clock';
import { fakeFetch } from '../support/fake-fetch';
import { ianaRoutes, loadFixture } from '../support/fixtures';

const IP = 'https://rdap.apnic.net/ip/1.1.1.1';
const AS = 'https://rdap.apnic.net/autnum/4608';

function setup(quotaPerHour = 1, scanThreshold = 200) {
  const clock = new FakeClock();
  const fetch = fakeFetch({
    ...ianaRoutes(),
    [IP]: { body: loadFixture('rdap/apnic/ip/1.1.1.1.json') },
    [AS]: { body: loadFixture('rdap/apnic/autnum/4608.json') },
  });
  const base = new RirService({ fetch, clock, userAgent: 't', cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock) });
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
});
