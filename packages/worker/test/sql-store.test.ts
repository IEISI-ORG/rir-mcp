import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { MemoryClientGate, MemoryRateLimiter, type BucketState, type CacheEntry, type ClientState, type Clock } from '@ieisi/rir-mcp-core';
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
  it('purges every expired row, keeping totals exact, and reports the next expiry (audit 2026-10-07 L4)', async () => {
    await inDo('cache-purge', async (sql) => {
      const clock = new FakeClock();
      const cache = new SqlCache(sql, clock);
      await cache.put('ip:198.51.100.23', entry('old', clock.t, 1_000, 5_000));
      await cache.put('ip:203.0.113.77', entry('new', clock.t, 1_000, 50_000));
      clock.t += 10_000;
      expect(cache.purgeExpired()).toBe(1_000_000 + 50_000);
      expect(sql.exec<{ key: string }>('SELECT key FROM cache').toArray().map((r) => r.key)).toEqual(['ip:203.0.113.77']);
      expect(cache.totals()).toEqual({ entries: 1, bytes: 5 });
      clock.t += 100_000;
      expect(cache.purgeExpired()).toBeNull();
      expect(cache.totals()).toEqual({ entries: 0, bytes: 0 });
    });
  });

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

describe('limiter and gate state through eviction (Review Focus 3)', () => {
  it('keeps an hourly cap window (LACNIC-style) across eviction', async () => {
    const profiles = { lacnic: { ratePerS: 100, burst: 100, hourlyCap: 2 } };
    const clock = new FakeClock();
    const make = (sql: SqlStorage) => new MemoryRateLimiter(profiles, clock, new SqlStateMap<BucketState>(sql, 'limiter'));
    await inDo('limiter-evict', async (sql) => {
      const l = make(sql);
      expect((await l.acquire('lacnic', 1)).ok).toBe(true);
      expect((await l.acquire('lacnic', 1)).ok).toBe(true);
    });
    await evictDurableObject(stub('limiter-evict'));
    expect((await inDo('limiter-evict', (sql) => make(sql).acquire('lacnic', 1))).ok).toBe(false);
  });

  it('keeps a suspension across eviction', async () => {
    const clock = new FakeClock();
    const alpha = { clientId: 'alpha', quotaPerHour: 60 };
    const make = (sql: SqlStorage) => new MemoryClientGate(clock, { state: new SqlStateMap<ClientState>(sql, 'gate'), salt: 's', scanThreshold: 1 });
    await inDo('gate-evict', async (sql) => {
      const g = make(sql);
      await g.observe(alpha, 'as:1');
      expect(await g.observe(alpha, 'as:2')).toMatchObject({ ok: false, reason: 'suspended' });
    });
    await evictDurableObject(stub('gate-evict'));
    expect(await inDo('gate-evict', (sql) => make(sql).charge(alpha, 1))).toMatchObject({ ok: false, reason: 'suspended' });
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

describe('SqlCache recency writes', () => {
  const usedAt = (sql: SqlStorage, k: string) => sql.exec<{ u: number }>('SELECT used_at AS u FROM cache WHERE key = ?', k).one().u;

  it('skips the recency write for an entry that is already among the most recent tenth', async () => {
    await inDo('recency-skip', async (sql) => {
      const clock = new FakeClock();
      const cache = new SqlCache(sql, clock, { maxEntries: 100 });
      await cache.put('k', entry('v', clock.now()));
      const before = usedAt(sql, 'k');
      await cache.get('k');
      expect(usedAt(sql, 'k')).toBe(before); // no write: still recent
      for (let i = 0; i < 20; i++) await cache.put(`o${i}`, entry('v', clock.now()));
      await cache.get('k');
      expect(usedAt(sql, 'k')).toBeGreaterThan(before); // fell out of the recent tenth: bumped
    });
  });
});

describe('SqlCache totals', () => {
  const actual = (sql: SqlStorage) => sql.exec<{ n: number; b: number }>('SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM cache').one();

  it('keeps its running totals equal to the table through puts, overwrites, expiry, oversize and eviction', async () => {
    await inDo('totals', async (sql) => {
      const clock = new FakeClock();
      const cache = new SqlCache(sql, clock, { maxEntries: 5, maxBytes: 10_000 });
      for (let i = 0; i < 8; i++) await cache.put(`k${i}`, entry('x'.repeat(10 * i), clock.now()));
      await cache.put('k7', entry('short', clock.now()));
      await cache.put('k6', entry('y'.repeat(500), clock.now())); // oversize: deleted
      await cache.put('e', entry('expiring', clock.now(), 10, 20));
      clock.t += 30;
      await cache.get('e');
      const { n, b } = actual(sql);
      expect(cache.totals()).toEqual({ entries: n, bytes: b });
      expect(n).toBeLessThanOrEqual(5);
    });
  });

  it('seeds its totals from the table after Durable Object eviction', async () => {
    await inDo('totals-evict', (sql) => new SqlCache(sql, new FakeClock()).put('k', entry('value', 1_000_000)));
    await evictDurableObject(stub('totals-evict'));
    const [totals, real] = await inDo('totals-evict', (sql) => [new SqlCache(sql, new FakeClock()).totals(), actual(sql)] as const);
    expect(totals).toEqual({ entries: real.n, bytes: real.b });
    expect(totals.entries).toBe(1);
  });
});

describe('createTables', () => {
  it('refuses a schema version it does not know', async () => {
    await inDo('schema-unknown', (sql) => {
      new SqlStateMap<string>(sql, 'meta').set('schema_version', '2');
      expect(() => createTables(sql)).toThrow(/schema version/);
    });
  });

  it('rebuilds an unversioned (pre-versioning) cache table instead of stamping it', async () => {
    await runInDurableObject(stub('schema-legacy'), async (_i, state) => {
      const sql = state.storage.sql;
      // What an older build left behind: no meta row, old column order, no bytes column.
      sql.exec('DROP TABLE IF EXISTS cache');
      sql.exec("DELETE FROM meta WHERE key = 'schema_version'");
      sql.exec('CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at INTEGER, fresh_until INTEGER, stale_until INTEGER, used_at INTEGER)');
      sql.exec("INSERT INTO cache VALUES ('k', '1', 0, 0, 0, 0)");
      createTables(sql);
      const cols = sql.exec<{ name: string }>('PRAGMA table_info(cache)').toArray().map((c) => c.name);
      expect(cols).toContain('bytes');
      expect(() => new SqlCache(sql, new FakeClock())).not.toThrow();
    });
  });

  it('records schema version 1 and stores bytes before the large value column', async () => {
    await inDo('schema', (sql) => {
      expect(new SqlStateMap<string>(sql, 'meta').get('schema_version')).toBe('1');
      const cols = sql.exec<{ name: string }>('PRAGMA table_info(cache)').toArray().map((c) => c.name);
      expect(cols.indexOf('bytes')).toBeLessThan(cols.indexOf('value'));
    });
  });


  it('is idempotent', async () => {
    await inDo('tables', (sql) => {
      createTables(sql);
      const names = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(['cache', 'gate', 'limiter', 'meta']));
    });
  });
});
