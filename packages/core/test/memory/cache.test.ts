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
    const cache = new MemoryCache(clock, 2);
    await cache.put('a', entry(clock, 'A'));
    await cache.put('b', entry(clock, 'B'));
    await cache.get('a');
    await cache.put('c', entry(clock, 'C'));
    expect(await cache.get('b')).toBeNull();
    expect((await cache.get<string>('a'))?.value).toBe('A');
    expect((await cache.get<string>('c'))?.value).toBe('C');
  });
});
