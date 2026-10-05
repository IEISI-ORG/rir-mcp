import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../src/memory/cache';
import { MemoryRateLimiter } from '../../src/memory/rate-limiter';
import type { ClientGate, ClientInfo, GateResult } from '../../src/ports';
import { DEFAULT_LIMITS } from '../../src/rdap/limits';
import { CachedFetcher, type ClientScope } from '../../src/service/fetcher';
import { FakeClock } from '../support/fake-clock';
import { fakeFetch } from '../support/fake-fetch';

const URL_A = 'https://rdap.apnic.net/ip/1.1.1.1';

/** Denies every charge for clients listed in `denied`; records who was charged. */
class FakeGate implements ClientGate {
  readonly charged: string[] = [];
  constructor(private readonly denied: ReadonlyMap<string, GateResult>) {}
  async charge(client: ClientInfo): Promise<GateResult> {
    this.charged.push(client.clientId);
    return this.denied.get(client.clientId) ?? { ok: true };
  }
  async observe(): Promise<GateResult> {
    return { ok: true };
  }
  async refund(): Promise<void> {}
}

function setup(denied: ReadonlyMap<string, GateResult>) {
  const clock = new FakeClock();
  const fetch = fakeFetch({ [URL_A]: { body: { ok: 1 } } });
  const fetcher = new CachedFetcher({
    http: { fetch, userAgent: 't' }, cache: new MemoryCache(clock), limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock),
    clock, rdapHosts: async () => new Set(['rdap.apnic.net']),
  });
  const gate = new FakeGate(denied);
  const scope = (clientId: string): ClientScope => ({ client: { clientId, quotaPerHour: 60 }, gate });
  const req = (s: ClientScope) => ({
    key: 'ip:1.1.1.1', rir: 'apnic' as const, url: URL_A, weight: 1, freshS: 60, staleS: 60, maxBytes: 1000,
    reduce: (raw: unknown) => raw, scope: s,
  });
  return { fetcher, fetch, gate, scope, req };
}

describe('CachedFetcher with client scopes', () => {
  it.each([
    ['quota', { ok: false, reason: 'quota', retryAfterS: 60 } as const, 'quota_exceeded'],
    ['suspended', { ok: false, reason: 'suspended', retryAfterS: 60 } as const, 'suspended'],
  ])('does not hand one client\'s %s denial to another client coalescing on the same key', async (_name, denial, code) => {
    const { fetcher, fetch, scope, req } = setup(new Map([['blocked', denial]]));
    const [blocked, allowed] = await Promise.all([fetcher.get(req(scope('blocked'))), fetcher.get(req(scope('allowed')))]);
    expect(blocked).toMatchObject({ ok: false, code });
    expect(allowed).toMatchObject({ ok: true, value: { ok: 1 } });
    expect(fetch.inits).toHaveLength(1);
  });

  it('charges only the client whose request reaches upstream; a coalescing client rides free', async () => {
    const { fetcher, fetch, gate, scope, req } = setup(new Map());
    const [a, b] = await Promise.all([fetcher.get(req(scope('a'))), fetcher.get(req(scope('b')))]);
    expect(a.ok && b.ok).toBe(true);
    expect(fetch.inits).toHaveLength(1);
    expect(gate.charged).toEqual(['a']);
  });
});

describe('coalescing across a cache read (Plan 1 Task 11)', () => {
  it('joins a fetch that is in flight when the request starts, even if it finishes during the cache read', async () => {
    const clock = new FakeClock();
    const fetch = fakeFetch({ [URL_A]: { body: { ok: 1 } } });
    const inner = new MemoryCache(clock);
    let gate: Promise<unknown> | undefined;
    // The second request's read sees the cache before the first fetch stores its result, then resumes after that
    // fetch is done. Armed just before the second request, so only its (synchronously started) read waits.
    let armed = false;
    const cache = {
      get: async <T,>(k: string) => {
        const wait = armed ? gate : undefined;
        armed = false;
        const snapshot = await inner.get<T>(k);
        if (wait) await wait;
        return snapshot;
      },
      put: inner.put.bind(inner),
    };
    const fetcher = new CachedFetcher({
      http: { fetch, userAgent: 't' }, cache, limiter: new MemoryRateLimiter(DEFAULT_LIMITS, clock),
      clock, rdapHosts: async () => new Set(['rdap.apnic.net']),
    });
    const req = { key: 'ip:1.1.1.1', rir: 'apnic' as const, url: URL_A, weight: 1, freshS: 60, staleS: 60, maxBytes: 1000, reduce: (raw: unknown) => raw };
    const first = fetcher.get(req);
    gate = first;
    armed = true;
    const second = fetcher.get(req);
    await Promise.all([first, second]);
    expect(fetch.calls.filter((u) => u === URL_A)).toHaveLength(1);
  });
});
