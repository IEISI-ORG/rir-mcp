import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildUserAgent, DEFAULT_LIMITS, MemoryCache, MemoryRateLimiter, RirService, systemClock } from '../../src/index';
import { renderNetwork } from '../../src/render/text';

// Node's 250 ms Happy Eyeballs default times out on high-latency RIRs (e.g. LACNIC, AFRINIC from Australia).
setDefaultAutoSelectFamilyAttemptTimeout(2000);

// Opt-in: RIR_MCP_LIVE=1 RIR_MCP_OPERATOR=you@example.net pnpm test:live  (one query per RIR)
describe.skipIf(process.env.RIR_MCP_LIVE !== '1')('live RDAP drift check', () => {
  let service: RirService;
  beforeAll(() => {
    service = new RirService({
      fetch: (url, init) => fetch(url, init),
      cache: new MemoryCache(systemClock),
      limiter: new MemoryRateLimiter(DEFAULT_LIMITS, systemClock),
      clock: systemClock,
      userAgent: buildUserAgent(process.env.RIR_MCP_OPERATOR ?? ''),
    });
  });

  it.each([
    ['apnic', '1.1.1.1'], ['arin', '8.8.8.8'], ['ripe', '193.0.6.139'], ['lacnic', '200.3.14.10'], ['afrinic', '196.216.2.1'],
  ])('%s answers %s', async (rir, ip) => {
    const a = await service.ip(ip);
    expect(a.kind).toBe('record');
    if (a.kind !== 'record') return;
    expect(a.meta.rir).toBe(rir);
    expect(a.record.prefixes.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(renderNetwork(a.record, a.meta)).length).toBeLessThan(600);
  }, 30_000);
});
