import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../src/memory/cache';
import { FakeClock } from '../support/fake-clock';

const entry = (clock: FakeClock, value: string) => ({
  value, fetchedAt: clock.now(), freshUntil: clock.now() + 1_000, staleUntil: clock.now() + 5_000,
});

describe('MemoryCache', () => {
  it('returns stored entries until staleUntil, then forgets them', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCache(clock);
    await cache.put('k', entry(clock, 'v'));
    expect((await cache.get<string>('k'))?.value).toBe('v');
    clock.advance(4_999);
    expect((await cache.get<string>('k'))?.value).toBe('v');
    clock.advance(1);
    expect(await cache.get('k')).toBeNull();
  });

  it('evicts the least recently used entry beyond maxEntries', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCache(clock, { maxEntries: 2 });
    await cache.put('a', entry(clock, 'A'));
    await cache.put('b', entry(clock, 'B'));
    await cache.get('a');
    await cache.put('c', entry(clock, 'C'));
    expect(await cache.get('b')).toBeNull();
    expect((await cache.get<string>('a'))?.value).toBe('A');
    expect((await cache.get<string>('c'))?.value).toBe('C');
  });

  it('evicts least recently used entries until under the byte limit', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCache(clock, { maxBytes: 10_000 });
    const v = 'x'.repeat(98); // 100 bytes as JSON: exactly the 1% single-value cap; 103 of them exceed 10,000
    for (const k of ['a', 'b', 'c']) await cache.put(k, entry(clock, v));
    for (let i = 0; i < 100; i++) await cache.put(`f${i}`, entry(clock, v));
    for (const k of ['a', 'b', 'c']) expect(await cache.get(k)).toBeNull();
    expect(await cache.get('f0')).not.toBeNull();
    expect(cache.totals()).toEqual({ entries: 100, bytes: 10_000 });
  });

  it('does not store a value over 1% of the byte limit, and drops the older entry for that key', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCache(clock, { maxBytes: 10_000 });
    await cache.put('k', entry(clock, 'small'));
    await cache.put('k', entry(clock, 'y'.repeat(200)));
    expect(await cache.get('k')).toBeNull();
    expect(cache.totals()).toEqual({ entries: 0, bytes: 0 });
  });

  it('keeps byte totals exact through overwrites and expiry', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCache(clock);
    await cache.put('k', entry(clock, 'aaaa'));
    await cache.put('k', entry(clock, 'bb'));
    await cache.put('j', entry(clock, 'c'));
    expect(cache.totals()).toEqual({ entries: 2, bytes: 4 + 3 });
    clock.advance(5_000);
    await cache.get('k');
    expect(cache.totals()).toEqual({ entries: 1, bytes: 3 });
  });
});
