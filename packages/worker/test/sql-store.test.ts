import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { CacheEntry, Clock } from '@ieisi/rir-mcp-core';
import { describe, expect, it } from 'vitest';
import { createTables, purgeExpiredScanUnits, SqlCache, SqlStateMap } from '../src/sql-store';

class FakeClock implements Clock {
  t = 1_000_000;
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.t += ms; }
}

const entry = (value: unknown, now: number, freshMs = 60_000, staleMs = 600_000): CacheEntry<unknown> =>
  ({ value, fetchedAt: now, freshUntil: now + freshMs, staleUntil: now + staleMs });

/** Each test gets its own DO instance (its own SQLite database). */
const stub = (name: string) => env.STATE.getByName(name);

function inDo<R>(name: string, fn: (sql: SqlStorage) => R | Promise<R>): Promise<R> {
  return runInDurableObject(stub(name), async (_instance, state) => {
    createTables(state.storage.sql);
    return fn(state.storage.sql);
  });
}

describe('SqlStateMap', () => {
  it('round-trips JSON values and overwrites on set', async () => {
    await inDo('map-roundtrip', (sql) => {
      const map = new SqlStateMap<{ n: number; units: string[] }>(sql, 'gate');
      expect(map.get('alpha')).toBeUndefined();
      map.set('alpha', { n: 1, units: ['a'] });
      map.set('alpha', { n: 2, units: ['a', 'b'] });
      expect(map.get('alpha')).toEqual({ n: 2, units: ['a', 'b'] });
    });
  });

  it('refuses a table name that is not one of the state tables', async () => {
    await inDo('map-table', (sql) => {
      expect(() => new SqlStateMap(sql, 'cache; DROP TABLE gate')).toThrow(/table/);
    });
  });

  it('survives eviction of the Durable Object', async () => {
    await inDo('map-evict', (sql) => new SqlStateMap<number[]>(sql, 'limiter').set('apnic', [1, 2, 3]));
    await evictDurableObject(stub('map-evict'));
    expect(await inDo('map-evict', (sql) => new SqlStateMap<number[]>(sql, 'limiter').get('apnic'))).toEqual([1, 2, 3]);
  });
});

describe('SqlCache', () => {
  it('round-trips an entry and returns null once stale', async () => {
    await inDo('cache-expiry', async (sql) => {
      const clock = new FakeClock();
      const cache = new SqlCache(sql, clock);
      expect(await cache.get('k')).toBeNull();
      const e = entry({ holder: 'APNIC' }, clock.now());
      await cache.put('k', e);
      expect(await cache.get('k')).toEqual(e);
      clock.t = e.staleUntil;
      expect(await cache.get('k')).toBeNull();
      expect(sql.exec('SELECT count(*) AS n FROM cache').one().n).toBe(0);
    });
  });

  it('evicts the least recently used entry when over the entry limit', async () => {
    await inDo('cache-count', async (sql) => {
      const clock = new FakeClock();
      const cache = new SqlCache(sql, clock, { maxEntries: 2 });
      await cache.put('a', entry('A', clock.now()));
      await cache.put('b', entry('B', clock.now()));
      await cache.get('a'); // a is now more recent than b
      await cache.put('c', entry('C', clock.now()));
      expect(await cache.get('b')).toBeNull();
      expect((await cache.get('a'))?.value).toBe('A');
      expect((await cache.get('c'))?.value).toBe('C');
    });
  });

  it('evicts least recently used entries until under the byte limit', async () => {
    await inDo('cache-bytes', async (sql) => {
      const clock = new FakeClock();
      const cache = new SqlCache(sql, clock, { maxBytes: 10_000 });
      const v = 'x'.repeat(98); // 100 bytes as JSON: exactly the 1% single-value cap; 103 of them exceed 10,000
      for (const k of ['a', 'b', 'c']) await cache.put(k, entry(v, clock.now()));
      for (let i = 0; i < 100; i++) await cache.put(`f${i}`, entry(v, clock.now()));
      const total = sql.exec('SELECT sum(bytes) AS b FROM cache').one().b as number;
      expect(total).toBeLessThanOrEqual(10_000);
      for (const k of ['a', 'b', 'c']) expect(await cache.get(k)).toBeNull();
      expect(await cache.get('f0')).not.toBeNull();
      expect(await cache.get('f99')).not.toBeNull();
    });
  });

  it('does not store a single value over 1% of the byte limit, and drops the older entry for that key', async () => {
    await inDo('cache-oversize', async (sql) => {
      const clock = new FakeClock();
      const cache = new SqlCache(sql, clock, { maxBytes: 10_000 });
      await cache.put('k', entry('small', clock.now()));
      await cache.put('k', entry('y'.repeat(200), clock.now()));
      expect(await cache.get('k')).toBeNull();
    });
  });

  it('survives eviction of the Durable Object', async () => {
    const e = entry({ holder: 'APNIC' }, 1_000_000);
    await inDo('cache-evict', (sql) => new SqlCache(sql, new FakeClock()).put('k', e));
    await evictDurableObject(stub('cache-evict'));
    expect(await inDo('cache-evict', (sql) => new SqlCache(sql, new FakeClock()).get('k'))).toEqual(e);
  });
});

describe('purgeExpiredScanUnits', () => {
  it('clears scan digests of expired windows only, keeps counts, and returns when the next one expires', async () => {
    await inDo('purge', (sql) => {
      const gate = new SqlStateMap<{ windowStart: number; used: number; units: string[]; suspendedUntil: number }>(sql, 'gate');
      const HOUR = 3_600_000;
      const now = 10 * HOUR;
      gate.set('old', { windowStart: now - HOUR, used: 3, units: ['aa', 'bb'], suspendedUntil: 0 });
      gate.set('live', { windowStart: now - 60_000, used: 1, units: ['cc'], suspendedUntil: 0 });
      gate.set('none', { windowStart: now - 5 * HOUR, used: 0, units: [], suspendedUntil: 0 });
      expect(purgeExpiredScanUnits(sql, now)).toBe(now - 60_000 + HOUR);
      expect(gate.get('old')).toEqual({ windowStart: now - HOUR, used: 3, units: [], suspendedUntil: 0 });
      expect(gate.get('live')?.units).toEqual(['cc']);
      expect(purgeExpiredScanUnits(sql, now + HOUR)).toBeNull();
      expect(gate.get('live')?.units).toEqual([]);
    });
  });
});

describe('createTables', () => {
  it('is idempotent', async () => {
    await inDo('tables', (sql) => {
      createTables(sql);
      const names = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(['cache', 'gate', 'limiter', 'meta']));
    });
  });
});
